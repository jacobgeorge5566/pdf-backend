const express= require('express');
const cors = require('cors');
const fileUpload = require('express-fileupload');
const pdfParse = require('pdf-parse');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const authRoutes = require("./routes/authRoutes");
const dotenv = require("dotenv");
const connectToDatabase = require("./config/database");
const { PDFDocument } = require('pdf-lib');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;


connectToDatabase();
dotenv.config();


const genAI = new GoogleGenerativeAI(process.env.API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-pro"});
const model2 = genAI.getGenerativeModel({ model: "gemini-pro-vision"});

const app = express();
app.use(express.json());
app.use(cors());
const port = 4000;
app.use(fileUpload());
app.use("/",express.static('public'));
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});

app.use('/api/v1', authRoutes);
app.use('/api/v1/friend',require('./routes/friend'))


app.post('/quicksummarize', async (req, res) => {
    if (!req.files || !req.files.pdfFile) {
        return res.status(400).send('No files were uploaded.');
    }
    const file = req.files.pdfFile; 
    console.log(file);
    try {
        const data = await pdfParse(file.data);
        let prompt = "Provide a detailed and comprehensive explanation of the following text \n";
        prompt += data.text;
        const result = await model.generateContent(prompt);
        const response = result.response;
        const text = response.text();
        res.status(200).json({
            success: true,
            data: text
        })
    } catch (error) {
        console.error('Error processing PDF:', error);
        res.status(500).json({
            success: false,
            error: error,
        });
    }
});
app.post('/chat', async (req, res) => {
    const chat = model.startChat({
        history: req.body.history,
    })
    const msg=req.body.message;
    const result = await chat.sendMessage(msg);
    const response = await result.response;
    const text = response.text();
    // res.send(text);
    res.status(200).json({
        success: true,
        data: text
    })
});


const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdir(uploadsDir, { recursive: true }).catch(console.error);

async function fileToGenerativePart(filePath, mimeType) {
    return {
        inlineData: { 
            data: Buffer.from(await fs.readFile(filePath)).toString("base64"),
            mimeType
        },
    };
}
const convertPdfToPng = (tempPdfPath, outputPath) => {
    return new Promise((resolve, reject) => {
        const child = spawn('pdftoppm', [tempPdfPath, outputPath, '-png']);
        child.on('error', (error) => {
            reject(`Error spawning pdftoppm: ${error}`);
        });
        child.on('close', (code) => {
            if (code !== 0) {
                reject(`pdftoppm process exited with code ${code}`);
            } else {
                resolve();
            }
        });
    });
};

const uploadImage = async (imgPath, i) => {
    const prompt = "briefly explain this ";

    const imageParts = [
        await fileToGenerativePart(imgPath, "image/png"),
    ];

    const result = await model2.generateContent([prompt, ...imageParts]);
    const response = await result.response;
    const text = await response.text();

    console.log(`Image ${i} uploaded successfully`);
    return text;
};


// image summarization
app.post('/detailSummarize', async (req, res) => {
    if (!req.files || !req.files.pdfFile) {
        return res.status(400).send('No file uploaded.');
    }

    const pdfFile = req.files.pdfFile;
    const pdfPath = path.join(uploadsDir, pdfFile.name);
    await fs.writeFile(pdfPath, pdfFile.data);

    try {
        const data = await fs.readFile(pdfPath);
        const pdfDoc = await PDFDocument.load(data);
        const numPages = pdfDoc.getPageCount();
        let allText = "";

        for (let i = 0; i < numPages; i++) {
            const tempPdf = await PDFDocument.create();
            const [copiedPage] = await tempPdf.copyPages(pdfDoc, [i]);
            tempPdf.addPage(copiedPage);

            const tempPdfBytes = await tempPdf.save();
            const tempPdfPath = path.join(uploadsDir, `temp_page_${i}.pdf`);
            await fs.writeFile(tempPdfPath, tempPdfBytes);

            const outputPath = path.join(uploadsDir, `temp_page_${i}`);
            await convertPdfToPng(tempPdfPath, outputPath);

            const imgPath = `${outputPath}-1.png`;
            const response = await uploadImage(imgPath, i);
            allText += response;

            setTimeout(() => {
                console.log(`${i}`);
            }, 5000);

            await fs.unlink(tempPdfPath);
            await fs.unlink(imgPath);
        }

        // res.send(allText);
        res.status(200).json({
            success: true,
            data: allText
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Error processing PDF');
    } finally {
        await fs.unlink(pdfPath);
    }
});