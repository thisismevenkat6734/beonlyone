"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const {
  getFirestore,
  FieldValue,
  Timestamp,
} = require("firebase-admin/firestore");

initializeApp();

const db = getFirestore();
const REGION = "us-central1";
const MAX_BATCH_SIZE = 400;

function callable(handler) {
  return onCall({ region: REGION }, handler);
}

function requireAuth(request) {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Please sign in first.");
  }
  return uid;
}

function cleanString(value, maxLength = 1000) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function requireUid(value, field = "uid") {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    value.includes("/")
  ) {
    throw new HttpsError("invalid-argument", `Invalid ${field}.`);
  }
  return value;
}

function connectionId(uidA, uidB) {
  return [uidA, uidB].sort().join("_");
}

function blockId(blockerUid, blockedUid) {
  return `${blockerUid}_${blockedUid}`;
}

async function ensureNotBlocked(uidA, uidB) {
  const ids = [
    blockId(uidA, uidB),
    blockId(uidB, uidA),
  ];

  const snapshots = await Promise.all(
    ids.map((id) => db.collection("blocks").doc(id).get())
  );

  if (snapshots.some((snapshot) => snapshot.exists)) {
    throw new HttpsError(
      "permission-denied",
      "This action is unavailable because of a block."
    );
  }
}

async function ensureConnected(uidA, uidB) {
  await ensureNotBlocked(uidA, uidB);

  const connection = await db
    .collection("connections")
    .doc(connectionId(uidA, uidB))
    .get();

  if (!connection.exists) {
    throw new HttpsError(
      "permission-denied",
      "An active connection is required."
    );
  }
}

async function enforceRateLimit(uid, action, maxRequests, windowMs) {
  const ref = db.collection("rateLimits").doc(`${uid}_${action}`);
  const now = Date.now();

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const data = snapshot.data() || {};
    const windowStart = data.windowStart?.toMillis?.() || 0;
    const count = data.count || 0;

    if (now - windowStart < windowMs && count >= maxRequests) {
      throw new HttpsError(
        "resource-exhausted",
        "Too many requests. Please try again later."
      );
    }

    const sameWindow = now - windowStart < windowMs;

    transaction.set(ref, {
      uid,
      action,
      windowStart: Timestamp.fromMillis(
        sameWindow ? windowStart : now
      ),
      count: sameWindow ? count + 1 : 1,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
}

async function createNotification({
  userId,
  actorUid,
  type,
  message,
  relatedId = null,
}) {
  if (!userId || userId === actorUid) return;

  await db.collection("notifications").add({
    userId,
    actorUid,
    type,
    message: cleanString(message, 240),
    relatedId,
    read: false,
    createdAt: FieldValue.serverTimestamp(),
  });
}

/**
 * Connection request lifecycle:
 * request, accept, reject, disconnect.
 */
exports.manageConnection = callable(async (request) => {
  const uid = requireAuth(request);
  const action = cleanString(request.data?.action, 30);
  const targetUid = requireUid(request.data?.targetUid, "targetUid");

  if (uid === targetUid) {
    throw new HttpsError(
      "invalid-argument",
      "You cannot connect to yourself."
    );
  }

  await enforceRateLimit(uid, "connection", 30, 60 * 60 * 1000);
  await ensureNotBlocked(uid, targetUid);

  const targetProfile = await db
    .collection("profiles")
    .doc(targetUid)
    .get();

  if (!targetProfile.exists) {
    throw new HttpsError("not-found", "Profile not found.");
  }

  const requests = db.collection("connectionRequests");
  const connections = db.collection("connections");
  const requestId = `${uid}_${targetUid}`;
  const reverseRequestId = `${targetUid}_${uid}`;
  const requestRef = requests.doc(requestId);
  const reverseRequestRef = requests.doc(reverseRequestId);
  const connectionRef = connections.doc(connectionId(uid, targetUid));

  if (action === "request") {
    const existingConnection = await connectionRef.get();

    if (existingConnection.exists) {
      return { success: true, status: "connected" };
    }

    const reverseRequest = await reverseRequestRef.get();

    if (
      reverseRequest.exists &&
      reverseRequest.data()?.status === "pending"
    ) {
      throw new HttpsError(
        "failed-precondition",
        "This person has already sent you a request. Accept it instead."
      );
    }

    const existingRequest = await requestRef.get();

    if (
      existingRequest.exists &&
      existingRequest.data()?.status === "pending"
    ) {
      return { success: true, status: "pending" };
    }

    await requestRef.set({
      fromUid: uid,
      toUid: targetUid,
      status: "pending",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    await createNotification({
      userId: targetUid,
      actorUid: uid,
      type: "connection_request",
      message: "Someone sent you a connection request.",
      relatedId: requestId,
    });

    return { success: true, status: "pending" };
  }

  if (action === "accept" || action === "reject") {
    const snapshot = await reverseRequestRef.get();

    if (
      !snapshot.exists ||
      snapshot.data()?.status !== "pending" ||
      snapshot.data()?.toUid !== uid
    ) {
      throw new HttpsError(
        "not-found",
        "A pending request from this person was not found."
      );
    }

    if (action === "reject") {
      await reverseRequestRef.update({
        status: "rejected",
        updatedAt: FieldValue.serverTimestamp(),
      });

      return { success: true, status: "rejected" };
    }

    const batch = db.batch();

    batch.set(connectionRef, {
      memberUids: [uid, targetUid].sort(),
      createdAt: FieldValue.serverTimestamp(),
    });

    batch.update(reverseRequestRef, {
      status: "accepted",
      updatedAt: FieldValue.serverTimestamp(),
    });

    if ((await requestRef.get()).exists) {
      batch.delete(requestRef);
    }

    await batch.commit();

    await createNotification({
      userId: targetUid,
      actorUid: uid,
      type: "connection_accepted",
      message: "Your connection request was accepted.",
      relatedId: connectionRef.id,
    });

    return { success: true, status: "connected" };
  }

  if (action === "disconnect") {
    const batch = db.batch();
    batch.delete(connectionRef);

    const outgoing = await requestRef.get();
    const incoming = await reverseRequestRef.get();

    if (outgoing.exists) batch.delete(requestRef);
    if (incoming.exists) batch.delete(reverseRequestRef);

    await batch.commit();
    return { success: true, status: "disconnected" };
  }

  throw new HttpsError("invalid-argument", "Unknown connection action.");
});

/**
 * Like/unlike a post and update the counter on the server.
 */
exports.toggleLike = callable(async (request) => {
  const uid = requireAuth(request);
  const postId = requireUid(request.data?.postId, "postId");

  await enforceRateLimit(uid, "like", 180, 60 * 60 * 1000);

  const postRef = db.collection("posts").doc(postId);
  const likeRef = postRef.collection("likes").doc(uid);

  const result = await db.runTransaction(async (transaction) => {
    const postSnapshot = await transaction.get(postRef);
    const likeSnapshot = await transaction.get(likeRef);

    if (!postSnapshot.exists) {
      throw new HttpsError("not-found", "Post not found.");
    }

    const post = postSnapshot.data();
    const ownerUid = post.uid;

    if (!ownerUid) {
      throw new HttpsError("failed-precondition", "Invalid post owner.");
    }

    await ensureNotBlocked(uid, ownerUid);

    if (post.visibility === "private" && ownerUid !== uid) {
      throw new HttpsError("permission-denied", "This post is private.");
    }

    if (
      post.visibility === "connections" &&
      ownerUid !== uid
    ) {
      await ensureConnected(uid, ownerUid);
    }

    if (likeSnapshot.exists) {
      transaction.delete(likeRef);
      transaction.update(postRef, {
        likeCount: Math.max(0, Number(post.likeCount || 0) - 1),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { liked: false };
    }

    transaction.set(likeRef, {
      uid,
      createdAt: FieldValue.serverTimestamp(),
    });

    transaction.update(postRef, {
      likeCount: Math.max(0, Number(post.likeCount || 0)) + 1,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return { liked: true };
  });

  return { success: true, ...result };
});

/**
 * Add a comment and update the comment counter atomically.
 */
exports.addComment = callable(async (request) => {
  const uid = requireAuth(request);
  const postId = requireUid(request.data?.postId, "postId");
  const text = cleanString(request.data?.text, 1000);

  if (!text) {
    throw new HttpsError("invalid-argument", "Comment cannot be empty.");
  }

  await enforceRateLimit(uid, "comment", 60, 60 * 60 * 1000);

  const postRef = db.collection("posts").doc(postId);
  const commentRef = postRef.collection("comments").doc();

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(postRef);

    if (!snapshot.exists) {
      throw new HttpsError("not-found", "Post not found.");
    }

    const post = snapshot.data();
    const ownerUid = post.uid;

    if (!ownerUid) {
      throw new HttpsError("failed-precondition", "Invalid post owner.");
    }

    await ensureNotBlocked(uid, ownerUid);

    if (post.visibility === "private" && ownerUid !== uid) {
      throw new HttpsError("permission-denied", "This post is private.");
    }

    if (
      post.visibility === "connections" &&
      ownerUid !== uid
    ) {
      await ensureConnected(uid, ownerUid);
    }

    transaction.set(commentRef, {
      uid,
      text,
      createdAt: FieldValue.serverTimestamp(),
    });

    transaction.update(postRef, {
      commentCount: Math.max(0, Number(post.commentCount || 0)) + 1,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  return { success: true, commentId: commentRef.id };
});

/**
 * Delete a post and its nested comments/likes.
 */
exports.deletePost = callable(async (request) => {
  const uid = requireAuth(request);
  const postId = requireUid(request.data?.postId, "postId");

  const postRef = db.collection("posts").doc(postId);
  const snapshot = await postRef.get();

  if (!snapshot.exists) {
    return { success: true };
  }

  if (snapshot.data()?.uid !== uid) {
    throw new HttpsError(
      "permission-denied",
      "You can only delete your own post."
    );
  }

  await db.recursiveDelete(postRef);
  return { success: true };
});

/**
 * Mark the signed-in user's notifications as read.
 */
exports.markNotificationsRead = callable(async (request) => {
  const uid = requireAuth(request);

  const snapshot = await db
    .collection("notifications")
    .where("userId", "==", uid)
    .where("read", "==", false)
    .limit(MAX_BATCH_SIZE)
    .get();

  if (snapshot.empty) {
    return { success: true, updated: 0 };
  }

  const batch = db.batch();

  snapshot.docs.forEach((doc) => {
    batch.update(doc.ref, {
      read: true,
      readAt: FieldValue.serverTimestamp(),
    });
  });

  await batch.commit();

  return {
    success: true,
    updated: snapshot.size,
    moreMayRemain: snapshot.size === MAX_BATCH_SIZE,
  };
});

/**
 * Explicitly share location with connected users or selected connections.
 * Coordinates are not made public by this function.
 */
exports.shareLocation = callable(async (request) => {
  const uid = requireAuth(request);
  const { latitude, longitude } = request.data || {};
  const audience = cleanString(request.data?.audience, 30);
  const durationMinutes = Number(request.data?.durationMinutes || 60);

  if (
    typeof latitude !== "number" ||
    typeof longitude !== "number" ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw new HttpsError("invalid-argument", "Invalid coordinates.");
  }

  if (
    !Number.isInteger(durationMinutes) ||
    durationMinutes < 15 ||
    durationMinutes > 1440
  ) {
    throw new HttpsError(
      "invalid-argument",
      "Duration must be between 15 and 1440 minutes."
    );
  }

  let recipientUids = [];

  if (audience === "connections") {
    const snapshot = await db
      .collection("connections")
      .where("memberUids", "array-contains", uid)
      .limit(200)
      .get();

    recipientUids = snapshot.docs
      .map((doc) => doc.data().memberUids?.find((id) => id !== uid))
      .filter(Boolean);
  } else if (audience === "selected") {
    const supplied = request.data?.recipientUids;

    if (!Array.isArray(supplied) || supplied.length < 1 || supplied.length > 50) {
      throw new HttpsError(
        "invalid-argument",
        "Select between 1 and 50 connected recipients."
      );
    }

    recipientUids = [...new Set(supplied.map((id) => requireUid(id)))];

    for (const recipientUid of recipientUids) {
      if (recipientUid === uid) {
        throw new HttpsError("invalid-argument", "Invalid recipient.");
      }
      await ensureConnected(uid, recipientUid);
    }
  } else {
    throw new HttpsError("invalid-argument", "Invalid location audience.");
  }

  await enforceRateLimit(uid, "location", 30, 60 * 60 * 1000);

  const expiresAt = Timestamp.fromMillis(
    Date.now() + durationMinutes * 60 * 1000
  );

  await db.collection("locations").doc(uid).set({
    uid,
    latitude,
    longitude,
    audience,
    recipientUids,
    active: true,
    expiresAt,
    updatedAt: FieldValue.serverTimestamp(),
  });

  return { success: true, expiresAt: expiresAt.toDate().toISOString() };
});

exports.stopLocationSharing = callable(async (request) => {
  const uid = requireAuth(request);
  const ref = db.collection("locations").doc(uid);
  const snapshot = await ref.get();

  if (snapshot.exists) {
    await ref.update({
      active: false,
      stoppedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  return { success: true };
});

/**
 * Block a user, remove the connection, and clear pending requests.
 */
exports.blockUser = callable(async (request) => {
  const uid = requireAuth(request);
  const targetUid = requireUid(request.data?.targetUid, "targetUid");

  if (uid === targetUid) {
    throw new HttpsError("invalid-argument", "You cannot block yourself.");
  }

  await enforceRateLimit(uid, "block", 30, 60 * 60 * 1000);

  const batch = db.batch();

  batch.set(db.collection("blocks").doc(blockId(uid, targetUid)), {
    blockerUid: uid,
    blockedUid: targetUid,
    createdAt: FieldValue.serverTimestamp(),
  });

  batch.delete(
    db.collection("connections").doc(connectionId(uid, targetUid))
  );

  const requestRefs = [
    db.collection("connectionRequests").doc(`${uid}_${targetUid}`),
    db.collection("connectionRequests").doc(`${targetUid}_${uid}`),
  ];

  const requestSnapshots = await Promise.all(
    requestRefs.map((ref) => ref.get())
  );

  requestSnapshots.forEach((snapshot, index) => {
    if (snapshot.exists) batch.delete(requestRefs[index]);
  });

  await batch.commit();

  return { success: true };
});

/**
 * Submit a report. Reports are private to trusted backend/admin workflows.
 */
exports.submitReport = callable(async (request) => {
  const uid = requireAuth(request);
  const reason = cleanString(request.data?.reason, 200);
  const details = cleanString(request.data?.details, 2000);
  const targetUid = request.data?.targetUid
    ? requireUid(request.data.targetUid, "targetUid")
    : null;
  const postId = request.data?.postId
    ? requireUid(request.data.postId, "postId")
    : null;

  if (!reason) {
    throw new HttpsError("invalid-argument", "A report reason is required.");
  }

  if (targetUid === uid) {
    throw new HttpsError("invalid-argument", "You cannot report yourself.");
  }

  await enforceRateLimit(uid, "report", 5, 60 * 60 * 1000);

  await db.collection("reports").add({
    reporterUid: uid,
    targetUid,
    postId,
    reason,
    details,
    status: "open",
    createdAt: FieldValue.serverTimestamp(),
  });

  return { success: true };
});

/**
 * Delete user-owned application data.
 * Firebase Authentication account deletion remains a separate step.
 */
exports.deleteAccountData = callable(async (request) => {
  const uid = requireAuth(request);

  await enforceRateLimit(uid, "deleteAccount", 2, 24 * 60 * 60 * 1000);

  const profileRef = db.collection("profiles").doc(uid);
  const locationRef = db.collection("locations").doc(uid);

  // Remove posts and all nested comments/likes owned by the user.
  const posts = await db.collection("posts").where("uid", "==", uid).get();

  for (const post of posts.docs) {
    await db.recursiveDelete(post.ref);
  }

  // Remove comments and likes this user made on other users' posts.
  for (const subcollection of ["comments", "likes"]) {
    let cursor = null;

    while (true) {
      let query = db.collectionGroup(subcollection)
        .where("uid", "==", uid)
        .limit(MAX_BATCH_SIZE);

      if (cursor) query = query.startAfter(cursor);

      const snapshot = await query.get();
      if (snapshot.empty) break;

      const batch = db.batch();
      snapshot.docs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();

      cursor = snapshot.docs[snapshot.docs.length - 1];
      if (snapshot.size < MAX_BATCH_SIZE) break;
    }
  }

  // Remove the user's stories.
  const stories = await db.collection("stories").where("uid", "==", uid).get();
  for (const story of stories.docs) {
    await db.recursiveDelete(story.ref);
  }

  // Remove connection requests in either direction.
  for (const field of ["fromUid", "toUid"]) {
    const requests = await db
      .collection("connectionRequests")
      .where(field, "==", uid)
      .get();

    for (let i = 0; i < requests.docs.length; i += MAX_BATCH_SIZE) {
      const batch = db.batch();
      requests.docs.slice(i, i + MAX_BATCH_SIZE).forEach((doc) => {
        batch.delete(doc.ref);
      });
      await batch.commit();
    }
  }

  // Remove connections containing this user.
  const connections = await db
    .collection("connections")
    .where("memberUids", "array-contains", uid)
    .get();

  for (let i = 0; i < connections.docs.length; i += MAX_BATCH_SIZE) {
    const batch = db.batch();
    connections.docs.slice(i, i + MAX_BATCH_SIZE).forEach((doc) => {
      batch.delete(doc.ref);
    });
    await batch.commit();
  }

  // Remove notifications belonging to this user.
  const notifications = await db
    .collection("notifications")
    .where("userId", "==", uid)
    .get();

  for (let i = 0; i < notifications.docs.length; i += MAX_BATCH_SIZE) {
    const batch = db.batch();
    notifications.docs.slice(i, i + MAX_BATCH_SIZE).forEach((doc) => {
      batch.delete(doc.ref);
    });
    await batch.commit();
  }

  // Remove blocks where this user is either party.
  for (const field of ["blockerUid", "blockedUid"]) {
    const blocks = await db.collection("blocks").where(field, "==", uid).get();

    for (let i = 0; i < blocks.docs.length; i += MAX_BATCH_SIZE) {
      const batch = db.batch();
      blocks.docs.slice(i, i + MAX_BATCH_SIZE).forEach((doc) => {
        batch.delete(doc.ref);
      });
      await batch.commit();
    }
  }

  // Stop and delete the location record.
  await locationRef.delete().catch(() => {});

  // Keep submitted reports for safety/audit purposes.
  await profileRef.delete().catch(() => {});

  return {
    success: true,
    message:
      "Application data deletion completed. Authentication account deletion is a separate step.",
  };
});
