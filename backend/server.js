// Load private configuration values from backend/.env.
require("dotenv").config();

// Import the tools used by this small web server.
const express = require("express");
const multer = require("multer");
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

// Read the AWS settings from environment variables; never put AWS keys here.
const AWS_REGION = process.env.AWS_REGION;
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;
const PORT = Number(process.env.PORT) || 3000;

// Create the Express app and the AWS S3 client. The AWS SDK gets credentials
// from the normal AWS credential chain (for example, an EC2 IAM role).
const app = express();
const s3 = new S3Client({ region: AWS_REGION });

// Allow routes to read JSON request bodies where needed.
app.use(express.json());

// Serve the HTML, CSS, and JavaScript from the existing frontend folder.
// This lets the page call /upload and /images on this same Express server.
app.use(express.static(path.join(__dirname, "../frontend")));

// Only accept files whose extension and browser-provided MIME type are both
// on the allowed list. The upload limit below is 5 MB per file.
const allowedTypes = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

// Check the file's actual bytes as well as its name and declared MIME type.
// This helps reject files that were simply renamed to end in .jpg, .png, etc.
function hasValidImageSignature(buffer, mimeType) {
  if (mimeType === "image/jpeg") {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }

  if (mimeType === "image/png") {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  }

  if (mimeType === "image/webp") {
    return buffer.length >= 12
      && buffer.toString("ascii", 0, 4) === "RIFF"
      && buffer.toString("ascii", 8, 12) === "WEBP";
  }

  return false;
}

const upload = multer({
  storage: multer.memoryStorage(), // Keep the small upload in memory before sending to S3.
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    const expectedMimeType = allowedTypes[extension];

    if (!expectedMimeType || file.mimetype !== expectedMimeType) {
      return callback(new Error("Only JPG, JPEG, PNG, and WEBP images are allowed."));
    }

    callback(null, true);
  },
});

// A simple check that confirms the backend is running.
app.get("/", (req, res) => {
  res.send("Cloud Image Gallery Backend is Running");
});

// Upload one image. Send the file as multipart/form-data using field name "image".
app.post("/upload", upload.single("image"), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Please attach an image in the "image" field.' });
    }

    if (!hasValidImageSignature(req.file.buffer, req.file.mimetype)) {
      return res.status(400).json({ error: "The uploaded file does not appear to be a valid supported image." });
    }

    const extension = path.extname(req.file.originalname).toLowerCase();
    const key = `${randomUUID()}${extension}`; // A unique S3 object name avoids filename collisions.

    await s3.send(new PutObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
      // Do not set public-read ACL: objects remain private in the bucket.
    }));

    res.status(201).json({
      message: "Image uploaded successfully.",
      image: { key, originalName: req.file.originalname },
    });
  } catch (error) {
    next(error);
  }
});

// List images and create a temporary viewing URL for each private S3 object.
app.get("/images", async (req, res, next) => {
  try {
    const images = [];
    let continuationToken;

    // S3 returns at most 1,000 objects per page; keep asking for pages if needed.
    do {
      const result = await s3.send(new ListObjectsV2Command({
        Bucket: S3_BUCKET_NAME,
        ContinuationToken: continuationToken,
      }));

      for (const object of result.Contents || []) {
        if (!object.Key) continue;

        const url = await getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: S3_BUCKET_NAME, Key: object.Key }),
          { expiresIn: 900 }, // Viewing links expire after 15 minutes.
        );

        // Make a second temporary link that asks the browser to download the image.
        const downloadUrl = await getSignedUrl(
          s3,
          new GetObjectCommand({
            Bucket: S3_BUCKET_NAME,
            Key: object.Key,
            ResponseContentDisposition: `attachment; filename="${path.basename(object.Key)}"`,
          }),
          { expiresIn: 900 },
        );

        images.push({
          key: object.Key,
          url,
          downloadUrl,
          size: object.Size,
          lastModified: object.LastModified,
        });
      }

      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuationToken);

    res.json({ images });
  } catch (error) {
    next(error);
  }
});

// Delete one object from S3 using its key, returned by POST /upload or GET /images.
app.delete("/images/:key", async (req, res, next) => {
  try {
    const key = req.params.key;
    if (!key) {
      return res.status(400).json({ error: "An image key is required." });
    }

    await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET_NAME, Key: key }));
    res.json({ message: "Image deleted successfully.", key });
  } catch (error) {
    next(error);
  }
});

// Convert upload errors and AWS/server errors into useful JSON responses.
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    const message = error.code === "LIMIT_FILE_SIZE"
      ? "The image must be 5 MB or smaller."
      : error.message;
    return res.status(status).json({ error: message });
  }

  if (error.message === "Only JPG, JPEG, PNG, and WEBP images are allowed.") {
    return res.status(400).json({ error: error.message });
  }

  console.error("Request failed:", error);
  res.status(500).json({ error: "The request could not be completed. Check the server logs for details." });
});

// Refuse to start if the required bucket settings are missing.
if (!AWS_REGION || !S3_BUCKET_NAME) {
  console.error("Set AWS_REGION and S3_BUCKET_NAME in backend/.env before starting the server.");
  process.exit(1);
}

// Start the API server.
app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});
