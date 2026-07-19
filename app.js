const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const cors = require("cors");

const { exec } = require("child_process");

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;

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

    // 2. extract page count
    const pages = await getPageCount(tempPath);

    // 3. delete temp file
    fs.unlinkSync(tempPath);

    res.json({ pages });
  } catch (err) {
    console.error(err);

    // cleanup if something fails
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);

    res.status(500).json({ error: "Failed to process PDF" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
