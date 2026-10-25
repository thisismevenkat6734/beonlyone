import { auth, db, functions } from "./firebase-config.js";

import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
  sendPasswordResetEmail,
  updateProfile,
  deleteUser
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";

import {
  collection,
  doc,
  addDoc,
  setDoc,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  increment
} from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";

import { httpsCallable } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-functions.js";

import {
  uploadMedia,
  createMediaPreview,
  revokeMediaPreview
} from "./cloudinary-upload.js";

/* =========================================================
   BeOnlyOne — Main frontend controller
   Firebase Auth + Firestore + Cloudinary
   ========================================================= */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) =>
  [...root.querySelectorAll(selector)];

const state = {
  user: null,
  profile: null,
  currentView: "feed",
  posts: [],
  selectedMood: "",
  selectedMedia: null,
  mediaPreviewUrl: null,
  lastPostDoc: null,
  loadingPosts: false,
  hasMorePosts: true,
  activeCommentPost: null,
  unsubscribe: [],
  theme: localStorage.getItem("beonlyone-theme") || "dark"
};

const COLLECTIONS = {
  profiles: "profiles",
  posts: "posts",
  stories: "stories",
  requests: "connectionRequests",
  connections: "connections",
  notifications: "notifications",
  blocks: "blocks",
  reports: "reports"
};

const MAX_POST_LENGTH = 2000;
const MAX_BIO_LENGTH = 300;
const PAGE_SIZE = 10;

const callable = (name) => httpsCallable(functions, name);

function escapeHTML(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function safeURL(value) {
  try {
    const url = new URL(value, window.location.origin);
    return ["https:", "http:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function formatDate(value) {
  const date = value?.toDate ? value.toDate() :
    value instanceof Date ? value : null;

  if (!date) return "Just now";

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function setText(selector, value) {
  const element = $(selector);
  if (element) element.textContent = value ?? "";
}

function showElement(selector, show = true) {
  const element = $(selector);
  if (element) element.hidden = !show;
}

function setMessage(selector, message, isError = false) {
  const element = $(selector);
  if (!element) return;

  element.textContent = message;
  element.classList.toggle("error", isError);
  element.classList.toggle("success", !isError && Boolean(message));
}

function toast(message, type = "info") {
  const region = $("#toast-region");
  if (!region) {
    console.info(`[BeOnlyOne] ${message}`);
    return;
  }

  const item = document.createElement("div");
  item.className = `toast toast-${type}`;
  item.setAttribute("role", "status");
  item.textContent = message;
  region.append(item);

  window.setTimeout(() => item.remove(), 4500);
}

function friendlyError(error) {
  const messages = {
    "auth/email-already-in-use": "Ee email tho account already undi.",
    "auth/invalid-email": "Valid email address enter cheyyi.",
    "auth/invalid-credential": "Email leda password correct kaadu.",
    "auth/user-not-found": "Ee email tho account dorakaledu.",
    "auth/wrong-password": "Password correct kaadu.",
    "auth/weak-password": "Strong password use cheyyi.",
    "auth/too-many-requests": "Chala attempts ayyayi. Konchem sepu tarvatha try cheyyi.",
    "auth/network-request-failed": "Internet connection check chesi malli try cheyyi.",
    "permission-denied": "Permission ledu. Firebase Security Rules/configuration check cheyyali.",
    "unavailable": "Service temporarily unavailable. Mallee try cheyyi."
  };

  return messages[error?.code] ||
    error?.message ||
    "Something went wrong. Mallee try cheyyi.";
}

function setBusy(button, busy, busyText = "Please wait…") {
  if (!button) return;

  if (busy) {
    button.dataset.originalText = button.textContent;
    button.disabled = true;
    button.textContent = busyText;
  } else {
    button.disabled = false;
    if (button.dataset.originalText) {
      button.textContent = button.dataset.originalText;
      delete button.dataset.originalText;
    }
  }
}

function makeHandle(name, uid) {
  const base = String(name || "member")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 18) || "member";

  return `${base}_${uid.slice(0, 6)}`;
}

function currentProfileData() {
  const user = state.user;
  const profile = state.profile || {};

  return {
    uid: user.uid,
    displayName: profile.displayName || user.displayName || "BeOnlyOne Member",
    handle: profile.handle || makeHandle(user.displayName, user.uid),
    photoURL: profile.photoURL || user.photoURL || "",
    bio: profile.bio || "",
    isPrivate: profile.isPrivate === true,
    allowDiscovery: profile.allowDiscovery !== false
  };
}

function clearSubscriptions() {
  state.unsubscribe.forEach((unsubscribe) => {
    try { unsubscribe(); } catch (error) {
      console.warn("Subscription cleanup failed", error);
    }
  });

  state.unsubscribe = [];
}

function applyTheme() {
  document.body.classList.toggle("light-theme", state.theme === "light");

  const button = $("#theme-toggle");
  if (button) {
    button.setAttribute(
      "aria-label",
      state.theme === "light" ? "Switch to dark theme" : "Switch to light theme"
    );
    button.textContent = state.theme === "light" ? "🌙" : "☀️";
  }
}

function switchView(view) {
  const validViews = [
    "feed", "moods", "reels", "stories", "connections",
    "discover", "map", "notifications", "profile", "settings",
    "search-results", "public-profile"
  ];

  if (!validViews.includes(view)) return;

  state.currentView = view;

  $$("[data-view]").forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });

  $$("[id$='-view']").forEach((section) => {
    section.hidden = section.id !== `${view}-view`;
  });

  if (view === "feed") loadPosts(true);
  if (view === "moods") loadMoods();
  if (view === "reels") loadReels();
  if (view === "stories") loadStories();
  if (view === "connections") loadConnections();
  if (view === "discover") loadPeople();
  if (view === "notifications") loadNotifications();
  if (view === "profile") loadOwnProfilePosts();
}

function showAuth() {
  showElement("#loading-screen", false);
  showElement("#auth-view", true);
  showElement("#main-view", false);
}

function showApplication() {
  showElement("#loading-screen", false);
  showElement("#auth-view", false);
  showElement("#main-view", true);
}

function switchAuthTab(tab) {
  const login = tab === "login";

  $("#login-tab")?.classList.toggle("active", login);
  $("#signup-tab")?.classList.toggle("active", !login);

  showElement("#login-form", login);
  showElement("#signup-form", !login);

  setMessage("#login-error", "");
  setMessage("#signup-error", "");
}

async function createProfile(user, displayName) {
  const ref = doc(db, COLLECTIONS.profiles, user.uid);
  const existing = await getDoc(ref);

  if (existing.exists()) {
    state.profile = existing.data();
    return state.profile;
  }

  const profile = {
    uid: user.uid,
    displayName: displayName || user.displayName || "BeOnlyOne Member",
    handle: makeHandle(displayName || user.displayName, user.uid),
    email: user.email || "",
    photoURL: user.photoURL || "",
    bio: "",
    isPrivate: false,
    allowDiscovery: true,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };

  await setDoc(ref, profile);
  state.profile = profile;
  return profile;
}

async function loadProfile(user) {
  const ref = doc(db, COLLECTIONS.profiles, user.uid);
  const snapshot = await getDoc(ref);

  if (snapshot.exists()) {
    state.profile = snapshot.data();
  } else {
    await createProfile(user, user.displayName);
  }

  renderProfileHeader();
  renderOwnProfile();
}

function renderProfileHeader() {
  const profile = currentProfileData();

  setText("#header-profile", profile.displayName);
  setText("#profile-name", profile.displayName);
  setText("#profile-handle", `@${profile.handle}`);
  setText("#profile-bio", profile.bio || "Share a little about yourself.");

  const avatar = $("#profile-avatar");
  if (avatar) {
    if (profile.photoURL) {
      avatar.src = safeURL(profile.photoURL);
      avatar.alt = `${profile.displayName} profile photo`;
      avatar.hidden = false;
    } else {
      avatar.removeAttribute("src");
      avatar.alt = `${profile.displayName} avatar`;
    }
  }

  const cover = $("#profile-cover");
  if (cover && profile.photoURL) {
    cover.style.backgroundImage = `linear-gradient(135deg, #5636a6, #ec4899)`;
  }

  const nameInput = $("#edit-display-name");
  const bioInput = $("#edit-bio");
  const privateToggle = $("#private-profile-toggle");
  const discoveryToggle = $("#allow-discovery-toggle");

  if (nameInput) nameInput.value = profile.displayName;
  if (bioInput) bioInput.value = profile.bio;
  if (privateToggle) privateToggle.checked = profile.isPrivate;
  if (discoveryToggle) discoveryToggle.checked = profile.allowDiscovery;
}

function renderOwnProfile() {
  const ownPosts = state.posts.filter((post) => post.uid === state.user?.uid);

  setText("#profile-post-count", String(ownPosts.length));
  renderPosts("#profile-posts", ownPosts, { showActions: true });
}

/* ----------------------- Authentication ----------------------- */

async function handleLogin(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const button = $("button[type='submit']", form);
  const email = $("#login-email")?.value.trim();
  const password = $("#login-password")?.value;

  setMessage("#login-error", "");

  if (!email || !password) {
    setMessage("#login-error", "Email mari password enter cheyyi.", true);
    return;
  }

  setBusy(button, true, "Logging in…");

  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (error) {
    setMessage("#login-error", friendlyError(error), true);
  } finally {
    setBusy(button, false);
  }
}

async function handleSignup(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const button = $("button[type='submit']", form);
  const displayName = $("#signup-name")?.value.trim();
  const email = $("#signup-email")?.value.trim();
  const password = $("#signup-password")?.value || "";
  const confirmPassword = $("#signup-confirm")?.value || "";
  const acceptedTerms = $("#accept-terms")?.checked;

  setMessage("#signup-error", "");

  if (!displayName || !email || !password) {
    setMessage("#signup-error", "Required details anni fill cheyyi.", true);
    return;
  }

  if (displayName.length > 60) {
    setMessage("#signup-error", "Name 60 characters lopu undali.", true);
    return;
  }

  if (password.length < 8) {
    setMessage("#signup-error", "Password minimum 8 characters undali.", true);
    return;
  }

  if (password !== confirmPassword) {
    setMessage("#signup-error", "Passwords match avvatledu.", true);
    return;
  }

  if (!acceptedTerms) {
    setMessage("#signup-error", "Terms and Privacy Policy accept cheyyali.", true);
    return;
  }

  setBusy(button, true, "Creating account…");

  try {
    const credential = await createUserWithEmailAndPassword(auth, email, password);
    await updateProfile(credential.user, { displayName });
    await createProfile(credential.user, displayName);
    toast("Account created successfully.", "success");
  } catch (error) {
    setMessage("#signup-error", friendlyError(error), true);
  } finally {
    setBusy(button, false);
  }
}

async function handlePasswordReset() {
  const email = $("#login-email")?.value.trim();

  if (!email) {
    setMessage("#login-error", "Mundhu email address enter cheyyi.", true);
    return;
  }

  try {
    await sendPasswordResetEmail(auth, email);
    setMessage("#login-error", "Password reset email pampincham. Inbox check cheyyi.");
  } catch (error) {
    setMessage("#login-error", friendlyError(error), true);
  }
}

async function handleLogout() {
  try {
    clearSubscriptions();
    await signOut(auth);
  } catch (error) {
    toast(friendlyError(error), "error");
  }
}

/* -------------------------- Posts -------------------------- */

function postCard(post, options = {}) {
  const profile = post.profile || {};
  const name = escapeHTML(post.displayName || profile.displayName || "BeOnlyOne Member");
  const handle = escapeHTML(post.handle || profile.handle || "member");
  const text = escapeHTML(post.text || "");
  const mood = escapeHTML(post.mood || "");
  const postId = escapeHTML(post.id || "");
  const liked = post.likedByMe === true;
  const canDelete = post.uid === state.user?.uid;
  const media = post.media || null;

  let mediaHTML = "";

  if (media?.url) {
    const url = safeURL(media.url);
    const type = String(media.type || media.resourceType || "");

    if (url && type.startsWith("image")) {
      mediaHTML = `<img class="post-media" src="${escapeHTML(url)}" alt="Post media" loading="lazy">`;
    } else if (url && (type.startsWith("video") || type === "reel")) {
      mediaHTML = `<video class="post-media" src="${escapeHTML(url)}" controls playsinline preload="metadata"></video>`;
    } else if (url && type.startsWith("audio")) {
      mediaHTML = `<audio class="post-audio" src="${escapeHTML(url)}" controls preload="metadata"></audio>`;
    }
  }

  return `
    <article class="post-card" data-post-id="${postId}">
      <header class="post-header">
        <div class="post-avatar" aria-hidden="true">${name.slice(0, 1).toUpperCase()}</div>
        <div class="post-author">
          <strong>${name}</strong>
          <span>@${handle}</span>
          <time>${escapeHTML(formatDate(post.createdAt))}</time>
        </div>
        ${canDelete ? `<button type="button" class="post-delete" data-delete-post="${postId}" aria-label="Delete your post">•••</button>` : ""}
      </header>
      ${mood ? `<p class="post-mood-label">Feeling ${mood}</p>` : ""}
      ${text ? `<p class="post-text">${text.replace(/\n/g, "<br>")}</p>` : ""}
      ${mediaHTML}
      <footer class="post-actions">
        <button type="button" data-like-post="${postId}" aria-pressed="${liked}">
          ${liked ? "♥ Liked" : "♡ Like"} <span>${Number(post.likeCount || 0)}</span>
        </button>
        <button type="button" data-comment-post="${postId}">
          💬 Comment <span>${Number(post.commentCount || 0)}</span>
        </button>
        <button type="button" data-share-post="${postId}">↗ Share</button>
      </footer>
    </article>`;
}

function renderPosts(selector, posts, options = {}) {
  const container = $(selector);
  if (!container) return;

  if (!posts.length) {
    container.innerHTML = `<div class="empty-state">No posts yet. Be the first to share something.</div>`;
    return;
  }

  container.innerHTML = posts.map((post) => postCard(post, options)).join("");
}

async function getBlockedUids() {
  if (!state.user) return new Set();

  try {
    const q = query(
      collection(db, COLLECTIONS.blocks),
      where("blockerUid", "==", state.user.uid),
      limit(200)
    );

    const snapshot = await getDocs(q);
    return new Set(snapshot.docs.map((item) => item.data().blockedUid).filter(Boolean));
  } catch (error) {
    console.warn("Unable to load block list", error);
    return new Set();
  }
}

async function loadPosts(reset = false) {
  if (!state.user || state.loadingPosts) return;

  if (reset) {
    state.posts = [];
    state.lastPostDoc = null;
    state.hasMorePosts = true;
  }

  if (!state.hasMorePosts) {
    renderPosts("#feed-list", state.posts);
    return;
  }

  state.loadingPosts = true;

  try {
    const blocked = await getBlockedUids();

    // Public posts are queried first. Connection-only/private access must be
    // enforced by Firestore rules and a trusted backend, not by this UI.
    const q = query(
      collection(db, COLLECTIONS.posts),
      where("visibility", "==", "public"),
      orderBy("createdAt", "desc"),
      limit(PAGE_SIZE)
    );

    const snapshot = await getDocs(q);
    const loaded = snapshot.docs.map((item) => ({
      id: item.id,
      ...item.data()
    })).filter((post) => !blocked.has(post.uid));

    const enriched = await Promise.all(loaded.map(async (post) => {
      try {
        const likeRef = doc(db, COLLECTIONS.posts, post.id, "likes", state.user.uid);
        const likeSnapshot = await getDoc(likeRef);
        return { ...post, likedByMe: likeSnapshot.exists() };
      } catch {
        return post;
      }
    }));

    state.posts = reset ? enriched : [
      ...state.posts,
      ...enriched.filter((item) => !state.posts.some((old) => old.id === item.id))
    ];

    state.lastPostDoc = snapshot.docs.at(-1) || null;
    state.hasMorePosts = snapshot.docs.length === PAGE_SIZE;

    renderPosts("#feed-list", state.posts);
    renderOwnProfile();
  } catch (error) {
    console.error("Post feed failed", error);
    toast(`Feed load avvaledu: ${friendlyError(error)}`, "error");
  } finally {
    state.loadingPosts = false;
  }
}

async function publishPost(event) {
  event.preventDefault();

  if (!state.user) return;

  const form = event.currentTarget;
  const button = $("#publish-post-button");
  const text = $("#post-text")?.value.trim() || "";
  const mood = $("#post-mood")?.value || "";
  const visibility = $("#post-visibility")?.value || "public";
  const asStory = $("#post-as-story")?.checked === true;
  const file = $("#post-media")?.files?.[0] || null;

  setMessage("#post-error", "");

  if (!text && !file) {
    setMessage("#post-error", "Text leda photo/video/audio add cheyyi.", true);
    return;
  }

  if (text.length > MAX_POST_LENGTH) {
    setMessage("#post-error", `Post ${MAX_POST_LENGTH} characters lopu undali.`, true);
    return;
  }

  setBusy(button, true, "Publishing…");

  try {
    let media = null;

    if (file) {
      media = await uploadMedia(file, {
        onProgress: (percent) => {
          if (button) button.textContent = `Uploading ${percent}%`;
        }
      });
    }

    const profile = currentProfileData();

    const postData = {
      uid: state.user.uid,
      displayName: profile.displayName,
      handle: profile.handle,
      photoURL: profile.photoURL,
      text,
      mood,
      media,
      visibility,
      isStory: asStory,
      likeCount: 0,
      commentCount: 0,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };

    if (asStory) {
      await addDoc(collection(db, COLLECTIONS.stories), {
        ...postData,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
      });
    } else {
      await addDoc(collection(db, COLLECTIONS.posts), postData);
    }

    form.reset();
    clearMediaPreview();
    closeDialog("#composer-dialog");
    toast(asStory ? "Story published." : "Post published.", "success");
    await loadPosts(true);
    await loadOwnProfilePosts();
  } catch (error) {
    console.error("Publishing failed", error);
    setMessage("#post-error", friendlyError(error), true);
  } finally {
    setBusy(button, false);
  }
}

async function toggleLike(postId) {
  if (!state.user || !postId) return;

  try {
    const postRef = doc(db, COLLECTIONS.posts, postId);
    const likeRef = doc(db, COLLECTIONS.posts, postId, "likes", state.user.uid);
    const likeSnapshot = await getDoc(likeRef);

    if (likeSnapshot.exists()) {
      await deleteDoc(likeRef);
      await updateDoc(postRef, { likeCount: increment(-1) });
    } else {
      await setDoc(likeRef, {
        uid: state.user.uid,
        createdAt: serverTimestamp()
      });
      await updateDoc(postRef, { likeCount: increment(1) });
    }

    await loadPosts(true);
  } catch (error) {
    toast(`Like update avvaledu: ${friendlyError(error)}`, "error");
  }
}

async function deleteOwnPost(postId) {
  if (!state.user || !postId) return;
  if (!window.confirm("Ee post ni delete cheyyala?")) return;

  try {
    const ref = doc(db, COLLECTIONS.posts, postId);
    const snapshot = await getDoc(ref);

    if (!snapshot.exists() || snapshot.data().uid !== state.user.uid) {
      throw new Error("Ee post delete cheyyadaniki permission ledu.");
    }

    // Subcollections/media cleanup should be handled by trusted backend
    // so deleting a document does not leave orphaned media or comments.
    await deleteDoc(ref);
    toast("Post deleted.", "success");
    await loadPosts(true);
    await loadOwnProfilePosts();
  } catch (error) {
    toast(friendlyError(error), "error");
  }
}

async function sharePost(postId) {
  const url = `${window.location.origin}${window.location.pathname}#post-${encodeURIComponent(postId)}`;

  try {
    if (navigator.share) {
      await navigator.share({ title: "BeOnlyOne", text: "Check out this post", url });
    } else if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      toast("Post link copied.", "success");
    } else {
      toast("Sharing is not supported in this browser.", "error");
    }
  } catch (error) {
    if (error?.name !== "AbortError") toast("Share failed.", "error");
  }
}

/* -------------------------- Comments -------------------------- */

async function openComments(postId) {
  state.activeCommentPost = postId;

  const dialog = $("#comments-dialog");
  const list = $("#comments-list");

  if (!dialog || !list) {
    toast("Comments dialog HTML dorakaledu.", "error");
    return;
  }

  list.innerHTML = `<div class="empty-state">Loading comments…</div>`;
  dialog.showModal?.();

  try {
    const q = query(
      collection(db, COLLECTIONS.posts, postId, "comments"),
      orderBy("createdAt", "asc"),
      limit(100)
    );

    const snapshot = await getDocs(q);

    if (snapshot.empty) {
      list.innerHTML = `<div class="empty-state">No comments yet.</div>`;
      return;
    }

    list.innerHTML = snapshot.docs.map((item) => {
      const comment = item.data();
      return `
        <article class="activity-item">
          <strong>${escapeHTML(comment.displayName || "Member")}</strong>
          <p>${escapeHTML(comment.text || "")}</p>
          <time>${escapeHTML(formatDate(comment.createdAt))}</time>
        </article>`;
    }).join("");
  } catch (error) {
    list.textContent = friendlyError(error);
  }
}

async function submitComment(event) {
  event.preventDefault();

  const postId = state.activeCommentPost;
  const input = $("#comment-text");
  const text = input?.value.trim() || "";

  setMessage("#comment-error", "");

  if (!postId || !text) {
    setMessage("#comment-error", "Comment enter cheyyi.", true);
    return;
  }

  if (text.length > 1000) {
    setMessage("#comment-error", "Comment 1000 characters lopu undali.", true);
    return;
  }

  try {
    const profile = currentProfileData();

    await addDoc(collection(db, COLLECTIONS.posts, postId, "comments"), {
      uid: state.user.uid,
      displayName: profile.displayName,
      text,
      createdAt: serverTimestamp()
    });

    await updateDoc(doc(db, COLLECTIONS.posts, postId), {
      commentCount: increment(1)
    });

    if (input) input.value = "";
    await openComments(postId);
    await loadPosts(true);
  } catch (error) {
    setMessage("#comment-error", friendlyError(error), true);
  }
}

/* --------------------------- Moods --------------------------- */

async function publishMood(event) {
  event.preventDefault();

  if (!state.user) return;

  const text = $("#mood-text")?.value.trim() || "";
  const visibility = $("#mood-visibility")?.value || "public";

  setMessage("#mood-message", "");

  if (!state.selectedMood) {
    setMessage("#mood-message", "Mundhu mood select cheyyi.", true);
    return;
  }

  if (!text) {
    setMessage("#mood-message", "Nee feeling gurinchi konchem rayi.", true);
    return;
  }

  if (text.length > MAX_POST_LENGTH) {
    setMessage("#mood-message", "Text chala long ga undi.", true);
    return;
  }

  try {
    const profile = currentProfileData();

    await addDoc(collection(db, COLLECTIONS.posts), {
      uid: state.user.uid,
      displayName: profile.displayName,
      handle: profile.handle,
      photoURL: profile.photoURL,
      text,
      mood: state.selectedMood,
      media: null,
      visibility,
      isStory: false,
      likeCount: 0,
      commentCount: 0,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    $("#mood-form")?.reset();
    state.selectedMood = "";
    $$("[data-mood]").forEach((button) => button.classList.remove("active"));

    setMessage("#mood-message", "Nee feeling share ayyindi.");
    await loadMoods();
    await loadPosts(true);
  } catch (error) {
    setMessage("#mood-message", friendlyError(error), true);
  }
}

async function loadMoods() {
  const container = $("#mood-feed");
  if (!container || !state.user) return;

  try {
    const q = query(
      collection(db, COLLECTIONS.posts),
      where("mood", "!=", ""),
      orderBy("mood"),
      orderBy("createdAt", "desc"),
      limit(30)
    );

    const snapshot = await getDocs(q);
    const moods = snapshot.docs.map((item) => ({
      id: item.id,
      ...item.data()
    }));

    renderPosts("#mood-feed", moods);
  } catch (error) {
    console.warn("Mood feed query failed", error);
    container.textContent = "Mood feed load avvaledu. Firestore indexes/rules check cheyyali.";
  }
}

/* -------------------------- Stories -------------------------- */

async function loadStories() {
  const container = $("#all-stories-list");
  const strip = $("#stories-list");

  if (!state.user) return;

  try {
    const q = query(
      collection(db, COLLECTIONS.stories),
      where("expiresAt", ">", new Date()),
      orderBy("expiresAt"),
      limit(50)
    );

    const snapshot = await getDocs(q);

    const html = snapshot.docs.map((item) => {
      const story = item.data();
      return `
        <article class="story-card">
          <strong>${escapeHTML(story.displayName || "Member")}</strong>
          <p>${escapeHTML(story.text || "")}</p>
          <time>Expires ${escapeHTML(formatDate(story.expiresAt))}</time>
        </article>`;
    }).join("");

    if (container) {
      container.innerHTML = html || `<div class="empty-state">No active stories.</div>`;
    }

    if (strip) {
      strip.innerHTML = html || `<div class="empty-state">No stories yet.</div>`;
    }
  } catch (error) {
    console.warn("Story loading failed", error);
    if (container) container.textContent = friendlyError(error);
  }
}

/* ------------------------- Reels ------------------------- */

async function loadReels() {
  const container = $("#reels-list");
  if (!container || !state.user) return;

  try {
    const q = query(
      collection(db, COLLECTIONS.posts),
      where("visibility", "==", "public"),
      orderBy("createdAt", "desc"),
      limit(30)
    );

    const snapshot = await getDocs(q);

    const reels = snapshot.docs.map((item) => ({
      id: item.id,
      ...item.data()
    })).filter((post) => {
      const media = post.media || {};
      return media.type === "video" ||
        media.type === "reel" ||
        media.resourceType === "video";
    });

    renderPosts("#reels-list", reels);
  } catch (error) {
    container.textContent = `Reels load avvaledu: ${friendlyError(error)}`;
  }
}

/* ---------------------- Profile settings ---------------------- */

async function saveProfile(event) {
  event.preventDefault();

  if (!state.user) return;

  const button = $("button[type='submit']", event.currentTarget);
  const displayName = $("#edit-display-name")?.value.trim() || "";
  const bio = $("#edit-bio")?.value.trim() || "";
  const isPrivate = $("#private-profile-toggle")?.checked === true;
  const allowDiscovery = $("#allow-discovery-toggle")?.checked !== false;
  const file = $("#edit-avatar-file")?.files?.[0] || null;

  setMessage("#profile-edit-message", "");

  if (!displayName || displayName.length > 60) {
    setMessage("#profile-edit-message", "Name 1–60 characters undali.", true);
    return;
  }

  if (bio.length > MAX_BIO_LENGTH) {
    setMessage("#profile-edit-message", `Bio ${MAX_BIO_LENGTH} characters lopu undali.`, true);
    return;
  }

  setBusy(button, true, "Saving…");

  try {
    let photoURL = state.profile?.photoURL || state.user.photoURL || "";

    if (file) {
      const media = await uploadMedia(file);
      photoURL = media.url;
    }

    await updateProfile(state.user, { displayName, photoURL });

    await updateDoc(doc(db, COLLECTIONS.profiles, state.user.uid), {
      displayName,
      bio,
      photoURL,
      isPrivate,
      allowDiscovery,
      updatedAt: serverTimestamp()
    });

    state.profile = {
      ...state.profile,
      displayName,
      bio,
      photoURL,
      isPrivate,
      allowDiscovery
    };

    renderProfileHeader();
    setMessage("#profile-edit-message", "Profile updated successfully.");
    toast("Profile saved.", "success");
  } catch (error) {
    setMessage("#profile-edit-message", friendlyError(error), true);
  } finally {
    setBusy(button, false);
  }
}

async function loadOwnProfilePosts() {
  if (!state.user) return;

  try {
    const q = query(
      collection(db, COLLECTIONS.posts),
      where("uid", "==", state.user.uid),
      orderBy("createdAt", "desc"),
      limit(50)
    );

    const snapshot = await getDocs(q);
    const posts = snapshot.docs.map((item) => ({
      id: item.id,
      ...item.data()
    }));

    setText("#profile-post-count", String(posts.length));
    renderPosts("#profile-posts", posts);
  } catch (error) {
    console.warn("Profile posts load failed", error);
  }
}

/* --------------------- People and connections --------------------- */

async function loadPeople(searchTerm = "") {
  const container = $("#discover-list");
  if (!container || !state.user) return;

  try {
    const q = query(
      collection(db, COLLECTIONS.profiles),
      where("allowDiscovery", "==", true),
      limit(100)
    );

    const snapshot = await getDocs(q);
    const search = searchTerm.toLowerCase();

    const people = snapshot.docs.map((item) => item.data())
      .filter((person) => person.uid !== state.user.uid)
      .filter((person) => {
        if (!search) return true;
        return `${person.displayName || ""} ${person.handle || ""}`
          .toLowerCase().includes(search);
      });

    if (!people.length) {
      container.innerHTML = `<div class="empty-state">No people found.</div>`;
      return;
    }

    container.innerHTML = people.map((person) => `
      <article class="person-card">
        <div class="person-avatar" aria-hidden="true">
          ${escapeHTML((person.displayName || "M").slice(0, 1).toUpperCase())}
        </div>
        <div>
          <strong>${escapeHTML(person.displayName || "Member")}</strong>
          <p>@${escapeHTML(person.handle || "member")}</p>
          <p>${escapeHTML(person.bio || "")}</p>
        </div>
        <button type="button" data-connect-user="${escapeHTML(person.uid)}">
          Connect
        </button>
      </article>
    `).join("");
  } catch (error) {
    container.textContent = `People load avvaledu: ${friendlyError(error)}`;
  }
}

async function sendConnectionRequest(targetUid) {
  if (!state.user || !targetUid || targetUid === state.user.uid) return;

  try {
    // This callable function must be implemented and deployed in functions.
    // It must validate identity, duplicates, blocks, and rate limits server-side.
    const result = await callable("manageConnection")({
      action: "request",
      targetUid
    });

    toast(result.data?.message || "Connection request sent.", "success");
    await loadConnections();
  } catch (error) {
    toast(`Connection request failed: ${friendlyError(error)}`, "error");
  }
}

async function loadConnections() {
  if (!state.user) return;

  const requestsContainer = $("#requests-list");
  const connectionsContainer = $("#connections-list");

  try {
    const q = query(
      collection(db, COLLECTIONS.requests),
      where("toUid", "==", state.user.uid),
      where("status", "==", "pending"),
      limit(50)
    );

    const snapshot = await getDocs(q);

    if (requestsContainer) {
      requestsContainer.innerHTML = snapshot.empty
        ? `<div class="empty-state">No pending requests.</div>`
        : snapshot.docs.map((item) => {
          const request = item.data();
          return `
            <article class="person-card">
              <strong>${escapeHTML(request.fromName || "Member")}</strong>
              <button type="button" data-accept-request="${escapeHTML(item.id)}">Accept</button>
              <button type="button" data-reject-request="${escapeHTML(item.id)}">Decline</button>
            </article>`;
        }).join("");
    }

    if (connectionsContainer) {
      const connectionQuery = query(
        collection(db, COLLECTIONS.connections),
        where("memberUids", "array-contains", state.user.uid),
        limit(100)
      );

      const connectionSnapshot = await getDocs(connectionQuery);

      connectionsContainer.innerHTML = connectionSnapshot.empty
        ? `<div class="empty-state">No connections yet. Discover people to connect.</div>`
        : connectionSnapshot.docs.map((item) => {
          const connection = item.data();
          const otherUid = (connection.memberUids || [])
            .find((uid) => uid !== state.user.uid);

          return `
            <article class="person-card">
              <strong>${escapeHTML(connection.memberNames?.[otherUid] || "Connection")}</strong>
              <button type="button" data-disconnect-user="${escapeHTML(otherUid || "")}">Disconnect</button>
            </article>`;
        }).join("");
    }
  } catch (error) {
    console.warn("Connections query failed", error);
    if (requestsContainer) requestsContainer.textContent = friendlyError(error);
    if (connectionsContainer) connectionsContainer.textContent = friendlyError(error);
  }
}

async function handleConnectionAction(action, requestId, targetUid = "") {
  try {
    await callable("manageConnection")({
      action,
      requestId,
      targetUid
    });

    toast("Connection updated.", "success");
    await loadConnections();
  } catch (error) {
    toast(`Connection action failed: ${friendlyError(error)}`, "error");
  }
}

/* ------------------------ Notifications ------------------------ */

async function loadNotifications() {
  const container = $("#notifications-list");
  if (!state.user || !container) return;

  try {
    const q = query(
      collection(db, COLLECTIONS.notifications),
      where("userId", "==", state.user.uid),
      orderBy("createdAt", "desc"),
      limit(50)
    );

    const snapshot = await getDocs(q);

    container.innerHTML = snapshot.empty
      ? `<div class="empty-state">You're all caught up.</div>`
      : snapshot.docs.map((item) => {
        const notification = item.data();
        return `
          <article class="activity-item ${notification.read ? "" : "unread"}">
            <p>${escapeHTML(notification.message || "New activity")}</p>
            <time>${escapeHTML(formatDate(notification.createdAt))}</time>
          </article>`;
      }).join("");

    const unread = snapshot.docs.filter((item) => item.data().read !== true).length;
    setText("#notification-badge", unread ? String(unread) : "");
    showElement("#notification-badge", unread > 0);
  } catch (error) {
    container.textContent = friendlyError(error);
  }
}

async function markNotificationsRead() {
  try {
    await callable("markNotificationsRead")({});
    await loadNotifications();
    toast("Notifications marked as read.", "success");
  } catch (error) {
    toast(`Could not update notifications: ${friendlyError(error)}`, "error");
  }
}

/* ------------------------- Search ------------------------- */

async function searchPeople(event) {
  event?.preventDefault();

  const term = $("#people-search-input")?.value.trim() ||
    $("#global-search")?.value.trim() || "";

  if (!term) {
    toast("Search term enter cheyyi.");
    return;
  }

  switchView("discover");
  await loadPeople(term);
}

async function globalSearch(event) {
  event.preventDefault();

  const term = $("#global-search")?.value.trim();
  if (!term) return;

  switchView("search-results");

  const label = $("#search-results-label");
  const container = $("#search-results-list");

  if (label) label.textContent = `Results for “${term}”`;
  if (container) container.innerHTML = `<div class="empty-state">Searching people…</div>`;

  try {
    const q = query(
      collection(db, COLLECTIONS.profiles),
      where("allowDiscovery", "==", true),
      limit(100)
    );

    const snapshot = await getDocs(q);
    const lower = term.toLowerCase();

    const people = snapshot.docs.map((item) => item.data())
      .filter((person) => person.uid !== state.user.uid)
      .filter((person) =>
        `${person.displayName || ""} ${person.handle || ""}`
          .toLowerCase().includes(lower)
      );

    if (container) {
      container.innerHTML = people.length
        ? people.map((person) => `
          <article class="person-card">
            <strong>${escapeHTML(person.displayName || "Member")}</strong>
            <p>@${escapeHTML(person.handle || "member")}</p>
            <button type="button" data-connect-user="${escapeHTML(person.uid)}">Connect</button>
          </article>`).join("")
        : `<div class="empty-state">No matching people found.</div>`;
    }
  } catch (error) {
    if (container) container.textContent = friendlyError(error);
  }
}

/* ---------------------- Media composer ---------------------- */

function clearMediaPreview() {
  const preview = $("#media-preview");
  if (preview) preview.innerHTML = "";

  if (state.mediaPreviewUrl) {
    revokeMediaPreview(state.mediaPreviewUrl);
    state.mediaPreviewUrl = null;
  }

  state.selectedMedia = null;
}

function previewSelectedMedia(file) {
  clearMediaPreview();
  if (!file) return;

  try {
    const preview = createMediaPreview(file);
    state.mediaPreviewUrl = preview.url;
    state.selectedMedia = file;

    const container = $("#media-preview");
    if (!container) return;

    if (preview.type.startsWith("image")) {
      container.innerHTML = `<img src="${escapeHTML(preview.url)}" alt="Selected media preview">`;
    } else if (preview.type.startsWith("video")) {
      container.innerHTML = `<video src="${escapeHTML(preview.url)}" controls playsinline></video>`;
    } else if (preview.type.startsWith("audio")) {
      container.innerHTML = `<audio src="${escapeHTML(preview.url)}" controls></audio>`;
    }
  } catch (error) {
    setMessage("#post-error", friendlyError(error), true);
  }
}

function openComposer(type = "post") {
  const dialog = $("#composer-dialog");
  if (!dialog) {
    toast("Composer dialog dorakaledu.", "error");
    return;
  }

  setText("#composer-dialog-title", type === "story" ? "Create a story" : "Create a post");

  const storyToggle = $("#post-as-story");
  if (storyToggle) storyToggle.checked = type === "story";

  dialog.showModal?.();
}

function closeDialog(selector) {
  const dialog = $(selector);
  if (dialog?.open) dialog.close();
}

/* --------------------- Location sharing --------------------- */

async function startLocationSharing() {
  if (!state.user) return;

  const status = $("#location-status");
  const audience = $("#location-audience")?.value || "connections";
  const duration = Number($("#location-duration")?.value || 60);

  if (!navigator.geolocation) {
    setMessage("#location-status", "Ee browser lo location support ledu.", true);
    return;
  }

  if (status) status.textContent = "Requesting location permission…";

  navigator.geolocation.getCurrentPosition(async (position) => {
    try {
      // Coordinates are only sent after an explicit user action.
      // Backend must validate audience and expiry, and restrict who can read it.
      await callable("shareLocation")({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        audience,
        durationMinutes: Math.min(Math.max(duration, 15), 1440)
      });

      setMessage("#location-status", "Location sharing started. Stop it any time.");
      showElement("#location-stop-button", true);
    } catch (error) {
      setMessage("#location-status", friendlyError(error), true);
    }
  }, (error) => {
    const messages = {
      1: "Location permission deny ayyindi.",
      2: "Location temporarily unavailable.",
      3: "Location request timed out."
    };

    setMessage("#location-status", messages[error.code] || "Location access failed.", true);
  }, {
    enableHighAccuracy: true,
    timeout: 15000,
    maximumAge: 0
  });
}

async function stopLocationSharing() {
  try {
    await callable("stopLocationSharing")({});
    setMessage("#location-status", "Location sharing stopped.");
    showElement("#location-stop-button", false);
  } catch (error) {
    setMessage("#location-status", friendlyError(error), true);
  }
}

/* ------------------------- Safety ------------------------- */

async function blockUser(targetUid) {
  if (!targetUid || targetUid === state.user?.uid) return;

  try {
    await callable("blockUser")({ targetUid });
    toast("User blocked.", "success");
    await loadPosts(true);
    await loadPeople();
  } catch (error) {
    toast(`Block failed: ${friendlyError(error)}`, "error");
  }
}

async function reportProblem() {
  const reason = window.prompt("Report reason enter cheyyi:");
  if (!reason?.trim()) return;

  try {
    await callable("submitReport")({
      reason: reason.trim().slice(0, 1000),
      context: "website"
    });

    toast("Report submitted.", "success");
  } catch (error) {
    toast(`Report failed: ${friendlyError(error)}`, "error");
  }
}

async function deleteAccount() {
  if (!state.user) return;

  const confirmed = window.confirm(
    "Account delete cheyyala? Ee action permanent avvachu."
  );

  if (!confirmed) return;

  try {
    // The server should remove dependent Firestore records and media.
    await callable("deleteAccountData")({});
    await deleteUser(state.user);
    toast("Account deleted.", "success");
  } catch (error) {
    toast(
      `Account delete avvaledu: ${friendlyError(error)}. Recent login required ayyi undachu.`,
      "error"
    );
  }
}

/* -------------------------- Events -------------------------- */

function bindEvents() {
  $("#login-form")?.addEventListener("submit", handleLogin);
  $("#signup-form")?.addEventListener("submit", handleSignup);
  $("#forgot-password")?.addEventListener("click", handlePasswordReset);
  $("#login-tab")?.addEventListener("click", () => switchAuthTab("login"));
  $("#signup-tab")?.addEventListener("click", () => switchAuthTab("signup"));

  $("#search-form")?.addEventListener("submit", globalSearch);
  $("#people-search-form")?.addEventListener("submit", searchPeople);

  $("#theme-toggle")?.addEventListener("click", () => {
    state.theme = state.theme === "dark" ? "light" : "dark";
    localStorage.setItem("beonlyone-theme", state.theme);
    applyTheme();
  });

  $("#notifications-open")?.addEventListener("click", () => switchView("notifications"));
  $("#header-profile")?.addEventListener("click", () => switchView("profile"));

  $$("[data-view]").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });

  $("#composer-open")?.addEventListener("click", () => openComposer("post"));
  $("#first-post-button")?.addEventListener("click", () => openComposer("post"));
  $("#create-story-button")?.addEventListener("click", () => openComposer("story"));

  $$("[data-compose-type]").forEach((button) => {
    button.addEventListener("click", () => openComposer(button.dataset.composeType));
  });

  $("#post-form")?.addEventListener("submit", publishPost);
  $("#comment-form")?.addEventListener("submit", submitComment);
  $("#mood-form")?.addEventListener("submit", publishMood);
  $("#profile-edit-form")?.addEventListener("submit", saveProfile);

  $("#post-media")?.addEventListener("change", (event) => {
    previewSelectedMedia(event.target.files?.[0]);
  });

  $("#load-more-posts")?.addEventListener("click", () => loadPosts(false));
  $("#mark-notifications-read")?.addEventListener("click", markNotificationsRead);
  $("#location-start-button")?.addEventListener("click", startLocationSharing);
  $("#location-stop-button")?.addEventListener("click", stopLocationSharing);
  $("#report-problem-button")?.addEventListener("click", reportProblem);
  $("#delete-account-button")?.addEventListener("click", deleteAccount);

  $("#blocked-users-button")?.addEventListener("click", () => {
    toast("Blocked-user management UI/backend is a remaining implementation step.");
  });

  $("#location-sharing-toggle")?.addEventListener("change", (event) => {
    if (event.target.checked) {
      toast("Location share cheyyadaniki Start button press cheyyi.");
    } else {
      stopLocationSharing();
    }
  });

  $$("[data-mood]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedMood = button.dataset.mood;
      $$("[data-mood]").forEach((item) => {
        item.classList.toggle("active", item === button);
        item.setAttribute("aria-pressed", String(item === button));
      });
    });
  });

  // Delegated actions for posts, comments, people, and connection requests.
  document.addEventListener("click", async (event) => {
    const target = event.target.closest("button");
    if (!target) return;

    if (target.dataset.likePost) {
      await toggleLike(target.dataset.likePost);
    } else if (target.dataset.commentPost) {
      await openComments(target.dataset.commentPost);
    } else if (target.dataset.sharePost) {
      await sharePost(target.dataset.sharePost);
    } else if (target.dataset.deletePost) {
      await deleteOwnPost(target.dataset.deletePost);
    } else if (target.dataset.connectUser) {
      await sendConnectionRequest(target.dataset.connectUser);
    } else if (target.dataset.acceptRequest) {
      await handleConnectionAction("accept", target.dataset.acceptRequest);
    } else if (target.dataset.rejectRequest) {
      await handleConnectionAction("reject", target.dataset.rejectRequest);
    } else if (target.dataset.disconnectUser) {
      await handleConnectionAction("disconnect", "", target.dataset.disconnectUser);
    } else if (target.dataset.blockUser) {
      await blockUser(target.dataset.blockUser);
    }
  });

  // Close buttons use data-close-dialog="#dialog-id".
  $$("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => {
      closeDialog(button.dataset.closeDialog);
    });
  });

  $("#composer-dialog")?.addEventListener("close", clearMediaPreview);
}

/* ------------------------- Application start ------------------------- */

function initialiseApp() {
  applyTheme();
  bindEvents();

  onAuthStateChanged(auth, async (user) => {
    clearSubscriptions();
    state.user = user;
    state.profile = null;
    state.posts = [];

    if (!user) {
      showAuth();
      return;
    }

    showApplication();

    try {
      await loadProfile(user);
      await Promise.all([
        loadPosts(true),
        loadStories(),
        loadNotifications()
      ]);
    } catch (error) {
      console.error("App initialisation failed", error);
      toast(`App setup issue: ${friendlyError(error)}`, "error");
    }
  });
}

initialiseApp();
