

import { fileURLToPath } from "url";
import { dirname } from "path";
import { promisify } from "util";
import { execFile } from "child_process";
import { pipeline } from "stream/promises";

import os from "os";
import fs from "fs";
import path from "path";
import express from "express";
import axios from "axios";
import multer from "multer";
import cors from "cors";
import "dotenv/config";
import webpush from "web-push";
import { v2 as cloudinary } from "cloudinary";

import { supabase } from "./supabase.js";


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// --------------------------------------------------
// CONFIGURATION
// --------------------------------------------------

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

webpush.setVapidDetails(
  "mailto:jumadomi518@gmail.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// --------------------------------------------------
// CLOUDINARY: UPLOAD FIRST-PAGE PREVIEW
// --------------------------------------------------

function uploadPreview(imageBuffer) {

  return new Promise((resolve, reject) => {

    const upload = cloudinary.uploader.upload_stream(
      {
        resource_type: "image",
        folder: "campuszone/previews",
        format: "jpg",
        quality: "auto",
        unique_filename: true
      },
      (error, result) => {

        if (error) {
          return reject(error);
        }

        resolve(result.secure_url);

      }
    );

    upload.end(imageBuffer);

  });

}

// --------------------------------------------------
// PDF PAGE COUNT USING MUPDF
// --------------------------------------------------

async function getPageCount(filePath) {

  const { stdout } = await execFileAsync(
    "mutool",
    ["info", filePath],
    {
      timeout: 30000,
      maxBuffer: 1024 * 1024
    }
  );

  const match = stdout.match(/Pages:\s*(\d+)/i);

  if (!match) {
    throw new Error("Could not extract PDF page count");
  }

  return Number(match[1]);

}

// --------------------------------------------------
// DOCX TO PDF + FIRST PAGE IMAGE
// --------------------------------------------------

async function convertDocxToPdf(fileBuffer) {

  const tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "campuszone-")
  );

  try {

    const inputPath = path.join(tempDir, "document.docx");
    const outputPath = path.join(tempDir, "document.pdf");
    const previewPrefix = path.join(tempDir, "preview");

    await fs.promises.writeFile(inputPath, fileBuffer);

    // Convert DOCX to PDF using LibreOffice
    await execFileAsync(
      "libreoffice",
      [
        "--headless",
        `-env:UserInstallation=file://${path.join(tempDir, "lo-profile")}`,
        "--convert-to",
        "pdf",
        "--outdir",
        tempDir,
        inputPath
      ],
      {
        timeout: 120000,
        maxBuffer: 5 * 1024 * 1024
      }
    );

    // Read generated PDF
    const pdfBuffer = await fs.promises.readFile(outputPath);

    // Count pages
    const pages = await getPageCount(outputPath);

    // Extract ONLY the first page as JPG
    await execFileAsync(
      "pdftoppm",
      [
        "-f", "1",
        "-l", "1",
        "-jpeg",
        "-r", "120",
        "-singlefile",
        outputPath,
        previewPrefix
      ],
      {
        timeout: 60000
      }
    );

    const previewPath = `${previewPrefix}.jpg`;

    const previewBuffer = await fs.promises.readFile(previewPath);

    return {
      previewBuffer,
      pages,
      pdfFileSize: pdfBuffer.length
    };

  } finally {

    // Delete DOCX, PDF, JPG and LibreOffice profile
    await fs.promises.rm(tempDir, {
      recursive: true,
      force: true
    });

  }

}

// --------------------------------------------------
// MULTER: DOCX UPLOAD
// --------------------------------------------------

const docxUpload = multer({

  storage: multer.memoryStorage(),

  limits: {
    fileSize: 10 * 1024 * 1024
  },

  fileFilter: (req, file, cb) => {

    const validMime =
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

    if (
      file.mimetype === validMime &&
      path.extname(file.originalname).toLowerCase() === ".docx"
    ) {

      cb(null, true);

    } else {

      cb(new Error("Only DOCX files are allowed"));

    }

  }

});

// --------------------------------------------------
// DOCX CONVERSION ENDPOINT
// --------------------------------------------------

app.post(
  "/convert-docx",
  docxUpload.single("file"),
  async (req, res) => {

    try {

      if (!req.file) {

        return res.status(400).json({
          success: false,
          message: "Please upload a DOCX file"
        });

      }

      // Convert DOCX and extract first page
      const result = await convertDocxToPdf(req.file.buffer);

      // Upload ONLY the JPG preview to Cloudinary
      const preview = await uploadPreview(result.previewBuffer);

      res.json({

        success: true,

        preview,

        pages: result.pages,

        // Original DOCX size
        fileSize: req.file.size,

        // Converted PDF size (optional metadata)
        pdfFileSize: result.pdfFileSize

      });

    } catch (error) {

      console.error("DOCX conversion error:", error);

      res.status(500).json({

        success: false,

        message: "Failed to convert DOCX document"

      });

    }

  }
);

// --------------------------------------------------
// DOWNLOAD PDF FROM URL
// --------------------------------------------------

// Restrict PDF downloads to trusted hosts.
// Set PDF_ALLOWED_HOSTS in Render environment variables.
const allowedPdfHosts = (process.env.PDF_ALLOWED_HOSTS || "")
  .split(",")
  .map(host => host.trim().toLowerCase())
  .filter(Boolean);

async function downloadPDF(url, outputPath) {

  const parsedUrl = new URL(url);

  if (parsedUrl.protocol !== "https:") {
    throw new Error("Only HTTPS PDF URLs are allowed");
  }

  if (
    allowedPdfHosts.length === 0 ||
    !allowedPdfHosts.includes(parsedUrl.hostname.toLowerCase())
  ) {
    throw new Error("PDF download host is not allowed");
  }

  const response = await axios({

    url,
    method: "GET",
    responseType: "stream",

    timeout: 60000,

    maxContentLength: 100 * 1024 * 1024,

    maxBodyLength: 100 * 1024 * 1024,

    maxRedirects: 0

  });

  await pipeline(
    response.data,
    fs.createWriteStream(outputPath)
  );

}

// --------------------------------------------------
// PDF PAGE COUNT ENDPOINT
// --------------------------------------------------

app.get("/pages", async (req, res) => {

  const pdfUrl = req.query.url;

  if (!pdfUrl || typeof pdfUrl !== "string") {

    return res.status(400).json({
      success: false,
      message: "Missing PDF URL"
    });

  }

  const tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "campuszone-pdf-")
  );

  const tempPath = path.join(tempDir, "document.pdf");

  try {

    // Download PDF
    await downloadPDF(pdfUrl, tempPath);

    // Extract page count
    const pages = await getPageCount(tempPath);

    res.json({
      success: true,
      pages
    });

  } catch (error) {

    console.error("PDF page count error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to process PDF"
    });

  } finally {

    await fs.promises.rm(tempDir, {
      recursive: true,
      force: true
    });

  }

});

// --------------------------------------------------
// SAVE PUSH SUBSCRIPTION
// --------------------------------------------------

app.post("/api/save-subscription", async (req, res) => {

  const { subscription, userId } = req.body;

  if (!subscription || !userId) {

    return res.status(400).json({
      success: false,
      message: "Missing subscription or user ID"
    });

  }

  const { error } = await supabase
    .from("push_subscriptions")
    .upsert(
      {
        user_id: userId,
        subscription
      },
      {
        onConflict: "user_id"
      }
    );

  if (error) {

    console.error("Supabase error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to save subscription"
    });

  }

  res.status(201).json({
    success: true
  });

});

// --------------------------------------------------
// SEND PUSH NOTIFICATION
// --------------------------------------------------

app.post("/api/send", async (req, res) => {

  const { title, body, url, senderId } = req.body;

  try {

    const { data, error } = await supabase
      .from("push_subscriptions")
      .select("user_id, subscription");

    if (error) {

      console.error("Supabase error:", error);

      return res.status(500).json({
        success: false,
        message: "Database error"
      });

    }

    // Exclude sender
    const recipients = (data || []).filter(
      sub => sub.user_id !== senderId
    );

    const payload = JSON.stringify({
      title,
      body,
      url
    });

    const results = await Promise.allSettled(

      recipients.map(sub =>
        webpush.sendNotification(
          sub.subscription,
          payload
        )
      )

    );

    const sent = results.filter(
      result => result.status === "fulfilled"
    ).length;

    // Remove expired subscriptions
    const expired = results
      .map((result, index) => ({
        result,
        recipient: recipients[index]
      }))
      .filter(item =>
        item.result.status === "rejected" &&
        [404, 410].includes(item.result.reason?.statusCode)
      );

    if (expired.length) {

      await supabase
        .from("push_subscriptions")
        .delete()
        .in(
          "user_id",
          expired.map(item => item.recipient.user_id)
        );

    }

    res.json({
      success: true,
      sent,
      failed: results.length - sent
    });

  } catch (error) {

    console.error("Notification error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to send notifications"
    });

  }

});

// --------------------------------------------------
// MULTER ERROR HANDLER
// --------------------------------------------------

app.use((err, req, res, next) => {

  if (err instanceof multer.MulterError) {

    return res.status(400).json({
      success: false,
      message: err.code === "LIMIT_FILE_SIZE"
        ? "DOCX file must not exceed 10 MB"
        : err.message
    });

  }

  if (err) {

    console.error("Request error:", err);

    return res.status(400).json({
      success: false,
      message: err.message || "Request failed"
    });

  }

  next();

});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

app.listen(PORT, () => {

  console.log(`Server running on port ${PORT}`);

});
