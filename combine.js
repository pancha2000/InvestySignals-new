const fs = require('fs');
const path = require('path');

// අවසාන ප්‍රතිඵලය හැදෙන ෆයිල් එකේ නම
const outputFileName = 'combined_code.txt';

// අයින් කළ යුතු (Ignore) ෆෝල්ඩර් සහ ෆයිල්ස්
const ignoreList = [
    'node_modules', 
    '.git', 
    'package-lock.json', 
    outputFileName, 
    'auth_info', // Baileys session ෆෝල්ඩර් එක
    'sessions',
    'LICENSE',     // License ෆයිල් එක අයින් කළා
    'README.md',   // Readme ෆයිල් එක අයින් කළා
    'readme.txt'
];

function getAllFiles(dirPath, arrayOfFiles) {
    const files = fs.readdirSync(dirPath);
    arrayOfFiles = arrayOfFiles || [];

    files.forEach(function(file) {
        if (fs.statSync(dirPath + "/" + file).isDirectory()) {
            if (!ignoreList.includes(file)) {
                arrayOfFiles = getAllFiles(dirPath + "/" + file, arrayOfFiles);
            }
        } else {
            // පින්තූර සහ අනවශ්‍ය ෆයිල් ජාති අයින් කරන්න
            if (!ignoreList.includes(file) && !file.toLowerCase().includes('readme') && !file.toLowerCase().includes('license') && !file.endsWith('.jpg') && !file.endsWith('.png') && !file.endsWith('.mp4')) {
                arrayOfFiles.push(path.join(dirPath, "/", file));
            }
        }
    });
    return arrayOfFiles;
}

function combineFiles() {
    console.log('කෝඩ් එකතු කිරීම ආරම්භ කරමින් පවතී...');
    const allFiles = getAllFiles(__dirname);
    let combinedContent = '';

    allFiles.forEach(file => {
        const relativePath = path.relative(__dirname, file);
        const content = fs.readFileSync(file, 'utf8');
        
        combinedContent += `\n\n// ==========================================\n`;
        combinedContent += `// File Path: ${relativePath}\n`;
        combinedContent += `// ==========================================\n\n`;
        combinedContent += content;
    });

    fs.writeFileSync(outputFileName, combinedContent);
    console.log(`✅ සාර්ථකයි! ඔක්කොම කෝඩ් ටික ${outputFileName} එකට එකතු කළා.`);
}

combineFiles();
