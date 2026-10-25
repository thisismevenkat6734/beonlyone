"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const {
  getAuth
} = require("firebase-admin/auth");
const {
  getFirestore,
  FieldValue,
  Timestamp
} = require("firebase-admin/firestore");

initializeApp();

const db = getFirestore();
const REGION = "us-central1";

const COL = {
  profiles: "profiles",
  posts: "posts",
  stories: "stories",
  requests: "connectionRequests",
  connections: "connections",
  notifications: "notifications",
  blocks: "blocks",
  reports: "reports",
  locations: "locations"
};

function requireAuth(request) {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "Please sign in first.");
  }
  return request.auth.uid;
}

function requireString(value, field, max = 200) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > max
  ) {
    throw new HttpsError("invalid-argument", `Invalid ${field}.`);
  }
  return value.trim();
}

function connectionId(uid1, uid2) {
  const [first, second] = [uid1, uid2].sort();
  return `${first}_${second}`;
}

function blockId(blockerUid, blockedUid) {
  return `${blockerUid}_${blockedUid}`;
}

async function ensureNotBlocked(uid1, uid2) {
  const first = await db.collection(COL.blocks)
    .doc(blockId(uid1, uid2)).get();

  const second = await db.collection(COL.blocks)
    .doc(blockId(uid2, uid1)).get();

  if (first.exists || second.exists) {
    throw new HttpsError(
      "permission-denied",
      "This action is unavailable because of a block."
    );
  }
}

async function getProfile(uid) {
  const snapshot = await db.collection(COL.profiles).doc(uid).get();
  if (!snapshot.exists) {
    throw new HttpsError("not-found", "Profile not found.");
  }
  return snapshot.data();
}

async function createNotification({
  userId,
  fromUid,
  type,
  message,
  relatedId = null
}) {
  if (!userId || userId === fromUid) return;

  await db.collection(COL.notifications).add({
    userId,
    fromUid,
    type,
    message,
    relatedId,
    read: false,
    createdAt: FieldValue.serverTimestamp()
  });
}

async function assertNoExistingRequest(fromUid, toUid) {
  const outgoing = await db.collection(COL.requests)
    .where("fromUid", "==", fromUid)
    .where("toUid", "==", toUid)
    .where("status", "==", "pending")
    .limit(1)
    .get();

  const incoming = await db.collection(COL.requests)
    .where("fromUid", "==", toUid)
    .where("toUid", "==", fromUid)
    .where("status", "==", "pending")
    .limit(1)
    .get();

  if (!outgoing.empty || !incoming.empty) {
    throw new HttpsError(
      "already-exists",
      "A pending connection request already exists."
    );
  }
}

/*
 * Connection requests and relationship changes.
 *
 * Actions:
 * request  -> targetUid
 * accept   -> requestId
 * reject   -> requestId
 * disconnect -> targetUid
 */
exports.manageConnection = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request);
  const action = requireString(request.data?.action, "action", 30);

  if (action === "request") {
    const targetUid = requireString(request.data?.targetUid, "targetUid", 128);

    if (uid === targetUid) {
      throw new HttpsError("invalid-argument", "You cannot connect to yourself.");
    }

    await ensureNotBlocked(uid, targetUid);

    const targetProfile = await getProfile(targetUid);
    const senderProfile = await getProfile(uid);

    if (targetProfile.isPrivate === true) {
      // Private profiles require a request; acceptance is still required.
    }

    const id = connectionId(uid, targetUid);
    const existingConnection = await db.collection(COL.connections).doc(id).get();

    if (existingConnection.exists) {
      throw new HttpsError("already-exists", "You are already connected.");
    }

    await assertNoExistingRequest(uid, targetUid);

    const requestRef = await db.collection(COL.requests).add({
      fromUid: uid,
      toUid: targetUid,
      fromName: senderProfile.displayName || "Member",
      status: "pending",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    await createNotification({
      userId: targetUid,
      fromUid: uid,
      type: "connection_request",
      message: `${senderProfile.displayName || "Someone"} sent you a connection request.`,
      relatedId: requestRef.id
    });

    return { success: true, message: "Connection request sent." };
  }

  if (action === "accept" || action === "reject") {
    const requestId = requireString(request.data?.requestId, "requestId", 128);
    const requestRef = db.collection(COL.requests).doc(requestId);
    const requestSnapshot = await requestRef.get();

    if (!requestSnapshot.exists) {
      throw new HttpsError("not-found", "Connection request not found.");
    }

    const relationship = requestSnapshot.data();

    if (relationship.toUid !== uid || relationship.status !== "pending") {
      throw new HttpsError("permission-denied", "You cannot act on this request.");
    }

    await ensureNotBlocked(relationship.fromUid, relationship.toUid);

    if (action === "reject") {
      await requestRef.update({
        status: "rejected",
        updatedAt: FieldValue.serverTimestamp()
      });

      return { success: true, message: "Request declined." };
    }

    const sender = await getProfile(relationship.fromUid);
    const recipient = await getProfile(relationship.toUid);
    const id = connectionId(relationship.fromUid, relationship.toUid);
    const connectionRef = db.collection(COL.connections).doc(id);

    await db.runTransaction(async (transaction) => {
      const freshRequest = await transaction.get(requestRef);
      const freshConnection = await transaction.get(connectionRef);

      if (
        !freshRequest.exists ||
        freshRequest.data().status !== "pending" ||
        freshRequest.data().toUid !== uid
      ) {
        throw new HttpsError("failed-precondition", "Request is no longer pending.");
      }

      if (freshConnection.exists) {
        throw new HttpsError("already-exists", "Connection already exists.");
      }

      transaction.set(connectionRef, {
        memberUids: [relationship.fromUid, relationship.toUid].sort(),
        memberNames: {
          [relationship.fromUid]: sender.displayName || "Member",
          [relationship.toUid]: recipient.displayName || "Member"
        },
        createdAt: FieldValue.serverTimestamp()
      });

      transaction.update(requestRef, {
        status: "accepted",
        updatedAt: FieldValue.serverTimestamp()
      });
    });

    await createNotification({
      userId: relationship.fromUid,
      fromUid: uid,
      type: "connection_accepted",
      message: `${recipient.displayName || "Someone"} accepted your connection request.`,
      relatedId: id
    });

    return { success: true, message: "Connection accepted." };
  }

  if (action === "disconnect") {
    const targetUid = requireString(request.data?.targetUid, "targetUid", 128);

    if (uid === targetUid) {
      throw new HttpsError("invalid-argument", "Invalid target.");
    }

    const id = connectionId(uid, targetUid);
    const connectionRef = db.collection(COL.connections).doc(id);
    const connectionSnapshot = await connectionRef.get();

    if (
      !connectionSnapshot.exists ||
      !connectionSnapshot.data().memberUids?.includes(uid) ||
      !connectionSnapshot.data().memberUids?.includes(targetUid)
    ) {
      throw new HttpsError("not-found", "Connection not found.");
    }

    await connectionRef.delete();

    return { success: true, message: "Connection removed." };
  }

  throw new HttpsError("invalid-argument", "Unsupported connection action.");
});

/*
 * Mark notifications as read for the authenticated user only.
 */
exports.markNotificationsRead = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request);

  const snapshot = await db.collection(COL.notifications)
    .where("userId", "==", uid)
    .where("read", "==", false)
    .limit(400)
    .get();

  if (snapshot.empty) return { success: true, updated: 0 };

  const batch = db.batch();
  snapshot.docs.forEach((item) => {
    batch.update(item.ref, {
      read: true,
      readAt: FieldValue.serverTimestamp()
    });
  });

  await batch.commit();

  return { success: true, updated: snapshot.size };
});

/*
 * Explicit opt-in location sharing.
 * Coordinates are private and are never made publicly readable by rules.
 */
exports.shareLocation = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request);

  const latitude = request.data?.latitude;
  const longitude = request.data?.longitude;
  const audience = request.data?.audience;
  const durationMinutes = request.data?.durationMinutes;

  if (
    typeof latitude !== "number" ||
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    typeof longitude !== "number" ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw new HttpsError("invalid-argument", "Invalid coordinates.");
  }

  if (!["connections", "selected"].includes(audience)) {
    throw new HttpsError("invalid-argument", "Invalid location audience.");
  }

  if (
    !Number.isInteger(durationMinutes) ||
    durationMinutes < 15 ||
    durationMinutes > 1440
  ) {
    throw new HttpsError("invalid-argument", "Invalid sharing duration.");
  }

  const expiresAt = Timestamp.fromMillis(
    Date.now() + durationMinutes * 60 * 1000
  );

  await db.collection(COL.locations).doc(uid).set({
    uid,
    latitude,
    longitude,
    audience,
    active: true,
    startedAt: FieldValue.serverTimestamp(),
    expiresAt,
    updatedAt: FieldValue.serverTimestamp()
  });

  return { success: true, expiresAt: expiresAt.toDate().toISOString() };
});

exports.stopLocationSharing = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request);

  await db.collection(COL.locations).doc(uid).set({
    uid,
    active: false,
    stoppedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });

  return { success: true };
});

/*
 * Block a user and remove an existing connection.
 * Block documents are not directly writable by clients.
 */
exports.blockUser = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request);
  const targetUid = requireString(request.data?.targetUid, "targetUid", 128);

  if (uid === targetUid) {
    throw new HttpsError("invalid-argument", "You cannot block yourself.");
  }

  await getProfile(targetUid);

  await db.collection(COL.blocks).doc(blockId(uid, targetUid)).set({
    blockerUid: uid,
    blockedUid: targetUid,
    createdAt: FieldValue.serverTimestamp()
  });

  await db.collection(COL.connections).doc(connectionId(uid, targetUid)).delete()
    .catch(() => {});

  return { success: true };
});

/*
 * Submit a report. Do not include unnecessary sensitive information.
 */
exports.submitReport = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request);
  const reason = requireString(request.data?.reason, "reason", 1000);
  const context = typeof request.data?.context === "string"
    ? request.data.context.slice(0, 80)
    : "website";

  const ref = await db.collection(COL.reports).add({
    reporterUid: uid,
    reason,
    context,
    status: "open",
    createdAt: FieldValue.serverTimestamp()
  });

  return { success: true, reportId: ref.id };
});

/*
 * Delete the authenticated user's Firestore data.
 * Auth account deletion is performed by the client after this callable returns.
 * This function does not delete Cloudinary assets; that requires a trusted
 * Cloudinary cleanup implementation using server-only credentials.
 */
exports.deleteAccountData = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request);

  const dbRef = db;
  const profileRef = dbRef.collection(COL.profiles).doc(uid);

  // Remove user-owned posts and their subcollections.
  const ownedPosts = await dbRef.collection(COL.posts)
    .where("uid", "==", uid)
    .get();

  for (const post of ownedPosts.docs) {
    await dbRef.recursiveDelete(post.ref);
  }

  // Remove user-owned stories.
  const ownedStories = await dbRef.collection(COL.stories)
    .where("uid", "==", uid)
    .get();

  for (const story of ownedStories.docs) {
    await story.ref.delete();
  }

  // Remove requests involving this account.
  for (const field of ["fromUid", "toUid"]) {
    const requests = await dbRef.collection(COL.requests)
      .where(field, "==", uid)
      .get();

    for (const item of requests.docs) {
      await item.ref.delete();
    }
  }

  // Remove connections involving this account.
  const connections = await dbRef.collection(COL.connections)
    .where("memberUids", "array-contains", uid)
    .get();

  for (const item of connections.docs) {
    await item.ref.delete();
  }

  // Remove notifications owned by this account.
  const notifications = await dbRef.collection(COL.notifications)
    .where("userId", "==", uid)
    .get();

  for (const item of notifications.docs) {
    await item.ref.delete();
  }

  // Remove blocks in both directions.
  for (const field of ["blockerUid", "blockedUid"]) {
    const blocks = await dbRef.collection(COL.blocks)
      .where(field, "==", uid)
      .get();

    for (const item of blocks.docs) {
      await item.ref.delete();
    }
  }

  await dbRef.collection(COL.locations).doc(uid).delete().catch(() => {});
  await profileRef.delete().catch(() => {});

  return {
    success: true,
    message: "Firestore account data cleanup completed."
  };
});
