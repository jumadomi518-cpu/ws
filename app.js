

import multer from "multer";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { supabase } from "./supabase.js";
import webpush from "web-push";
import dotenv from "dotenv";
import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";
import cors from "cors";
import { exec } from "child_process";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;


 function generatePreviewUrl(pdfUrl) {
  const safeUrl = encodeURIComponent(decodeURIComponent(pdfUrl));
  return `https://res.cloudinary.com/dvw9bab1v/image/fetch/f_auto,q_auto,pg_1/${safeUrl}`;
}



// Convert DOCX to PDF and count pages
async function convertDocxToPdf(fileBuffer) {

  const tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "campuszone-")
  );

  try {

    const inputPath = path.join(tempDir, "document.docx");
    const outputPath = path.join(tempDir, "document.pdf");

    await fs.promises.writeFile(inputPath, fileBuffer);

    await execFileAsync("libreoffice", [
      "--headless",
      `-env:UserInstallation=file://${path.join(tempDir, "lo-profile")}`,
      "--convert-to",
      "pdf",
      "--outdir",
      tempDir,
      inputPath
    ], {
      timeout: 120000
    });

    // Read generated PDF
    const pdfBuffer = await fs.promises.readFile(outputPath);

    const pages = await getPageCount(outputPath);

    return {
      pdfBuffer,
      pages,
      fileSize: pdfBuffer.length
    };

  } finally {

    // Delete temporary files
    await fs.promises.rm(tempDir, {
      recursive: true,
      force: true
    });

  }
}



//Download PDF from Supabase
async function downloadPDF(url, outputPath) {
  const response = await axios({
    url,
    method: "GET",
    responseType: "stream",
  });

  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);

    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}

//Get page count using MuPDF
function getPageCount(filePath) {
  return new Promise((resolve, reject) => {
    exec(`mutool info "${filePath}"`, (err, stdout) => {
      if (err) return reject(err);

      const match = stdout.match(/Pages:\s+(\d+)/);
      if (match) resolve(parseInt(match[1]));
      else reject("Could not extract page count");
    });
  });
}

//API endpoint
app.get("/pages", async (req, res) => {
  const pdfUrl = req.query.url;

  if (!pdfUrl) {
    return res.status(400).json({ error: "Missing URL" });
  }

  // unique temp file (important for multiple users)
  const tempPath = path.join(__dirname, `temp-${Date.now()}.pdf`);

  try {
    //download PDF
    await downloadPDF(pdfUrl, tempPath);

    //extract page count
    const pages = await getPageCount(tempPath);

    //delete temp file
    fs.unlinkSync(tempPath);

    res.json({ pages });
  } catch (err) {
    console.error(err);

    // cleanup if something fails
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);

    res.status(500).json({ error: "Failed to process PDF" });
  }
});


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



webpush.setVapidDetails(
  "mailto:jumadomi518@gmail.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

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

      const result = await convertDocxToPdf(req.file.buffer);

      const preview = generatePreviewUrl(result.pdfBuffer);

      res.json({
       success: true,
       pdfUrl,
       preview,
       pages: result.pages,
      fileSize: result.fileSize
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

  // save in DB (Supabase)
  app.post("/api/save-subscription", async (req, res) => {
  const { subscription, userId } = req.body;

  console.log("Incoming:", req.body);

  const { data, error } = await supabase
    .from("push_subscriptions")
    .upsert(
      {
        user_id: userId,
        subscription
      },
      { onConflict: "user_id" }
    );

  if (error) {
    console.log("Supabase error:", error);
    return res.status(500).json(error);
  }

  console.log("Saved:", data);
  res.status(201).json({ success: true });
});

app.post("/api/send", async (req, res) => {
  const { title, body, url, senderId } = req.body;

  const { data, error } = await supabase
    .from("push_subscriptions")
    .select("subscription");


const recipients = data.filter(sub => sub.user_id !== senderId);


 if (error) {
  console.log(error);
  return res.status(500).send("DB error");
}


  const payload = JSON.stringify({
    title,
    body,
    url
  });

  await Promise.allSettled(
  recipients.map(sub =>
    webpush.sendNotification(sub.subscription, payload)
      .catch(err => {
        console.log("Push failed:", err.statusCode);
      })
  )
);

  res.send("Sent");
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
