// These relative URLs call the API on the same Express server that serves this page.
const API = "";
const input = document.querySelector("#image-input");
const grid = document.querySelector("#gallery-grid");
const emptyState = document.querySelector("#gallery-empty");
const errorMessage = document.querySelector("#gallery-error");
const uploadStatus = document.querySelector("#upload-status");
const imageCount = document.querySelector("#image-count");
const refreshButton = document.querySelector("#refresh-button");

// Show a readable file size such as 240 KB or 1.4 MB.
function formatSize(bytes = 0) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.hidden = false;
}

// Fetch the image list and draw one card for each S3 object.
async function loadImages() {
  errorMessage.hidden = true;
  grid.innerHTML = '<p class="loading-message">Gathering your photos…</p>';
  emptyState.hidden = true;

  try {
    const response = await fetch(`${API}/images`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not load your gallery.");

    const images = result.images || [];
    grid.innerHTML = "";
    imageCount.textContent = images.length;
    emptyState.hidden = images.length !== 0;

    images.forEach((image, index) => {
      const card = document.createElement("article");
      card.className = "photo-card";
      card.style.animationDelay = `${Math.min(index, 8) * 45}ms`;

      const frame = document.createElement("div");
      frame.className = "photo-frame";
      const preview = document.createElement("img");
      preview.src = image.url;
      preview.alt = `Gallery image ${index + 1}`;
      preview.loading = "lazy";
      frame.append(preview);

      const info = document.createElement("div");
      info.className = "photo-info";
      const meta = document.createElement("div");
      meta.className = "photo-meta";
      const name = document.createElement("span");
      name.className = "photo-name";
      name.textContent = image.key.split("/").pop();
      name.title = name.textContent;
      const size = document.createElement("span");
      size.className = "photo-size";
      size.textContent = formatSize(image.size);
      meta.append(name, size);

      const actions = document.createElement("div");
      actions.className = "photo-actions";
      const download = document.createElement("a");
      download.className = "action-button";
      download.href = image.downloadUrl || image.url;
      download.textContent = "↓ Download";
      download.setAttribute("aria-label", `Download ${name.textContent}`);
      const remove = document.createElement("button");
      remove.className = "action-button action-delete";
      remove.type = "button";
      remove.textContent = "× Delete";
      remove.setAttribute("aria-label", `Delete ${name.textContent}`);
      remove.addEventListener("click", () => deleteImage(image.key));
      actions.append(download, remove);

      info.append(meta, actions);
      card.append(frame, info);
      grid.append(card);
    });
  } catch (error) {
    grid.innerHTML = "";
    imageCount.textContent = "—";
    showError(`${error.message} Make sure the backend is running and AWS is configured.`);
  }
}

// Send each selected image as multipart form data to the existing upload route.
async function uploadImages(files) {
  if (!files.length) return;
  uploadStatus.textContent = `Uploading ${files.length} photo${files.length === 1 ? "" : "s"}…`;
  input.disabled = true;

  try {
    for (const file of files) {
      const formData = new FormData();
      formData.append("image", file);
      const response = await fetch(`${API}/upload`, { method: "POST", body: formData });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `Could not upload ${file.name}.`);
    }
    uploadStatus.textContent = `${files.length} photo${files.length === 1 ? "" : "s"} added successfully.`;
    await loadImages();
  } catch (error) {
    uploadStatus.textContent = "";
    showError(error.message);
  } finally {
    input.disabled = false;
    input.value = ""; // Let the same file be selected again later.
  }
}

// Ask for confirmation, then call the existing DELETE /images/:key route.
async function deleteImage(key) {
  if (!window.confirm("Delete this image from your gallery? This cannot be undone.")) return;

  try {
    const response = await fetch(`${API}/images/${encodeURIComponent(key)}`, { method: "DELETE" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not delete this image.");
    await loadImages();
  } catch (error) {
    showError(error.message);
  }
}

input.addEventListener("change", () => uploadImages(Array.from(input.files)));
refreshButton.addEventListener("click", loadImages);

// Load existing S3 images as soon as the page opens.
loadImages();
