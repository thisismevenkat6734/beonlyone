/*
 * BeOnlyOne — Firebase Configuration
 *
 * This file initializes the Firebase web SDK.
 * Security must be enforced by Firebase Authentication,
 * Firestore Security Rules, and trusted backend functions.
 */

import { initializeApp, getApp, getApps } from
  "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";

import { getAuth } from
  "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";

import { getFirestore } from
  "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";

import { getFunctions } from
  "https://www.gstatic.com/firebasejs/12.4.0/firebase-functions.js";

const firebaseConfig = Object.freeze({
  apiKey: "AIzaSyDaYNxk89vnvc-SHrTNfNrQ0gJCYdnrBOI",
  authDomain: "createyourownidentity-2e2a3.firebaseapp.com",
  projectId: "createyourownidentity-2e2a3",
  storageBucket: "createyourownidentity-2e2a3.firebasestorage.app",
  messagingSenderId: "316875593955",
  appId: "1:316875593955:web:529cb0fe3c45f2cca54dd6",
  measurementId: "G-LXVR8CJWRE"
});

/*
 * Reuse the existing app instance if this module is
 * imported more than once.
 */
const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

const auth = getAuth(app);
const db = getFirestore(app);

/*
 * The backend functions must be deployed to this region.
 * We will configure and verify the actual functions later.
 */
const functions = getFunctions(app, "us-central1");

export {
  app,
  auth,
  db,
  functions,
  firebaseConfig
};
