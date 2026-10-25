
/*
 * BeOnlyOne — Cloudinary Media Upload
 *
 * Supports image, video and audio uploads.
 * Uses an unsigned upload preset.
 *
 * IMPORTANT:
 * An unsigned preset is public. Configure upload restrictions
 * in Cloudinary, and use authenticated backend moderation and
 * authorization for a production deployment.
 */

const CLOUD_NAME = "lqfozcs3";
const UPLOAD_PRESET = "create_your_own_identity";

const UPLOAD_ENDPOINT =
  `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/auto/upload`;

const MEDIA_LIMITS = Object.freeze({
  image: {
    maxBytes: 10 * 1024 * 1024,
    mimeTypes: ["image/jpeg", "image/png", "image/webp"]
  },
  video: {
    maxBytes: 50 * 1024 * 1024,
    maxDurationSeconds: 30,
    mimeTypes: ["video/mp4", "video/webm"]
  },
  audio: {
    maxBytes: 20 * 1024 * 1024,
    mimeTypes: [
      "audio/mpeg",
      "audio/mp4",
      "audio/ogg",
      "audio/webm",
      "audio/wav",
      "audio/x-wav"
    ]
  }
});

export class MediaUploadError extends Error {
  constructor(message, code = "UPLOAD_ERROR") {
    super(message);
    this.name = "MediaUploadError";
    this.code = code;
  }
}

function getMediaType(file) {
  if (!file || typeof file.size !== "number") {
    throw new MediaUploadError("Please select a valid file.", "INVALID_FILE");
  }

  const mime = (file.type || "").toLowerCase();

  if (MEDIA_LIMITS.image.mimeTypes.includes(mime)) return "image";
  if (MEDIA_LIMITS.video.mimeTypes.includes(mime)) return "video";
  if (MEDIA_LIMITS.audio.mimeTypes.includes(mime)) return "audio";

  throw new MediaUploadError(
    "Unsupported file type. Choose a JPEG, PNG, WebP, MP4, WebM or supported audio file.",
    "UNSUPPORTED_TYPE"
  );
}

function validateFile(file, type) {
  const rules = MEDIA_LIMITS[type];

  if (!rules) {
    throw new MediaUploadError("Unsupported media category.", "INVALID_CATEGORY");
  }

  if (file.size <= 0) {
    throw new MediaUploadError("The selected file is empty.", "EMPTY_FILE");
  }

  if (file.size > rules.maxBytes) {
    const maxMB = Math.round(rules.maxBytes / (1024 * 1024));

    throw new MediaUploadError(
      `${type.charAt(0).toUpperCase() + type.slice(1)} files must be ${maxMB} MB or smaller.`,
      "FILE_TOO_LARGE"
    );
  }
}

async function validateVideoDuration(file) {
  const objectUrl = URL.createObjectURL(file);

  try {
    const duration = await new Promise((resolve, reject) => {
      const video = document.createElement("video");

      video.preload = "metadata";

      video.onloadedmetadata = () => {
        resolve(video.duration);
        video.removeAttribute("src");
        video.load();
      };

      video.onerror = () => {
        reject(
          new MediaUploadError(
            "The video could not be read. Please choose another file.",
            "INVALID_VIDEO"
          )
        );
      };

      video.src = objectUrl;
    });

    if (!Number.isFinite(duration) || duration <= 0) {
      throw new MediaUploadError("Invalid video duration.", "INVALID_VIDEO");
    }

    if (duration > MEDIA_LIMITS.video.maxDurationSeconds + 0.15) {
      throw new MediaUploadError(
        "Videos must be 30 seconds or shorter.",
        "VIDEO_TOO_LONG"
      );
    }

    return duration;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function validateCloudinaryResponse(data, expectedType) {
  if (
    !data ||
    typeof data.secure_url !== "string" ||
    !data.secure_url.startsWith("https://") ||
    typeof data.public_id !== "string"
  ) {
    throw new MediaUploadError(
      "The media provider returned an invalid response.",
      "INVALID_RESPONSE"
    );
  }

  if (expectedType === "image" && data.resource_type !== "image") {
    throw new MediaUploadError("The uploaded file was not an image.", "TYPE_MISMATCH");
  }

  if (expectedType === "video" && data.resource_type !== "video") {
    throw new MediaUploadError("The uploaded file was not a video.", "TYPE_MISMATCH");
  }

  if (expectedType === "audio" && data.resource_type !== "video") {
    /*
     * Cloudinary generally stores audio assets under its
     * video resource type. Other resource types are rejected.
     */
    throw new MediaUploadError("The uploaded file was not recognized as audio.", "TYPE_MISMATCH");
  }

  return {
    url: data.secure_url,
    publicId: data.public_id,
    resourceType: data.resource_type,
    format: data.format || "",
    bytes: Number(data.bytes) || 0,
    duration: Number.isFinite(Number(data.duration))
      ? Number(data.duration)
      : null,
    width: Number(data.width) || null,
    height: Number(data.height) || null
  };
}

/**
 * Upload a media file to Cloudinary.
 *
 * @param {File} file
 * @param {Object} options
 * @param {(percent:number)=>void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<Object>}
 */
export async function uploadMedia(
  file,
  { onProgress, signal } = {}
) {
  if (signal?.aborted) {
    throw new MediaUploadError("Upload cancelled.", "UPLOAD_CANCELLED");
  }

  const type = getMediaType(file);
  validateFile(file, type);

  if (type === "video") {
    await validateVideoDuration(file);
  }

  if (
    typeof navigator !== "undefined" &&
    navigator.onLine === false
  ) {
    throw new MediaUploadError(
      "You appear to be offline. Reconnect and try again.",
      "OFFLINE"
    );
  }

  const formData = new FormData();
  formData.append("file", file);
  formData.append("upload_preset", UPLOAD_PRESET);

  /*
   * Do not send Firebase tokens, passwords, private keys,
   * or other secrets to an unsigned upload endpoint.
   */
  const xhr = new XMLHttpRequest();

  const result = await new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      signal?.removeEventListener("abort", abortUpload);
    };

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };

    const abortUpload = () => {
      xhr.abort();
      finish(
        reject,
        new MediaUploadError("Upload cancelled.", "UPLOAD_CANCELLED")
      );
    };

    signal?.addEventListener("abort", abortUpload, { once: true });

    xhr.open("POST", UPLOAD_ENDPOINT, true);
    xhr.timeout = 120000;

    xhr.upload.onprogress = event => {
      if (event.lengthComputable && typeof onProgress === "function") {
        const percent = Math.round((event.loaded / event.total) * 100);
        onProgress(Math.max(0, Math.min(100, percent)));
      }
    };

    xhr.onload = () => {
      let data;

      try {
        data = JSON.parse(xhr.responseText || "{}");
      } catch {
        finish(
          reject,
          new MediaUploadError(
            "Could not read the upload response.",
            "INVALID_RESPONSE"
          )
        );
        return;
      }

      if (xhr.status < 200 || xhr.status >= 300) {
        const providerMessage =
          typeof data?.error?.message === "string"
            ? data.error.message
            : "The media provider rejected the upload.";

        finish(
          reject,
          new MediaUploadError(providerMessage, "PROVIDER_ERROR")
        );
        return;
      }

      try {
        finish(resolve, validateCloudinaryResponse(data, type));
      } catch (error) {
        finish(reject, error);
      }
    };

    xhr.onerror = () => {
      finish(
        reject,
        new MediaUploadError(
          "A network error interrupted the upload.",
          "NETWORK_ERROR"
        )
      );
    };

    xhr.ontimeout = () => {
      finish(
        reject,
        new MediaUploadError(
          "The upload timed out. Please try again.",
          "TIMEOUT"
        )
      );
    };

    xhr.onabort = () => {
      finish(
        reject,
        new MediaUploadError("Upload cancelled.", "UPLOAD_CANCELLED")
      );
    };

    xhr.send(formData);
  });

  if (typeof onProgress === "function") {
    onProgress(100);
  }

  return {
    ...result,
    mediaType: type
  };
}

/**
 * Create a local preview URL.
 * Call revokeMediaPreview() when the preview is no longer needed.
 */
export function createMediaPreview(file) {
  getMediaType(file);
  return URL.createObjectURL(file);
}

export function revokeMediaPreview(url) {
  if (typeof url === "string" && url.startsWith("blob:")) {
    URL.revokeObjectURL(url);
  }
}

export { MEDIA_LIMITS };
