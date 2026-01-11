const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// 設定ファイルを読み込む
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

// Google Drive APIのスコープ
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

/**
 * Google Drive APIクライアントを認証します。
 * @returns {Promise<google.drive_v3.Drive>} Drive APIクライアント。
 */
async function authorize() {
    const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!serviceAccountJson) {
        throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set in environment variables.');
    }

    const credentials = JSON.parse(serviceAccountJson);

    const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: SCOPES,
    });

    const authClient = await auth.getClient();
    return google.drive({ version: 'v3', auth: authClient });
}

/**
 * 指定されたフォルダ名のIDを検索または作成します。
 * @param {google.drive_v3.Drive} drive - Drive APIクライアント。
 * @param {string} folderName - フォルダ名。
 * @param {string} parentId - 親フォルダのID。
 * @returns {Promise<string>} フォルダのID。
 */
async function getOrCreateFolder(drive, folderName, parentId) {
    const query = `'${parentId}' in parents and name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    let res = await drive.files.list({ q: query, fields: 'files(id, name)' });

    if (res.data.files.length > 0) {
        return res.data.files[0].id;
    } else {
        const fileMetadata = {
            'name': folderName,
            'mimeType': 'application/vnd.google-apps.folder',
            'parents': [parentId]
        };
        res = await drive.files.create({
            resource: fileMetadata,
            fields: 'id'
        });
        return res.data.id;
    }
}


/**
 * ファイルをGoogle Driveにアップロードします。
 * @param {string} filePath - アップロードするファイルのローカルパス。
 * @param {string} botName - Botの名前。
 */
async function uploadFile(filePath, botName) {
    try {
        console.log(`[${botName}] Starting upload for ${filePath}...`);
        const drive = await authorize();
        const parentFolderId = config.gdrive.parent_folder_id;

        if (!parentFolderId || parentFolderId === 'YOUR_GOOGLE_DRIVE_FOLDER_ID') {
            console.error(`[${botName}] Google Drive Parent Folder ID is not configured in config.json.`);
            return;
        }

        // YYYY-MM-DD 形式のフォルダを作成
        const date = new Date();
        const dateFolderName = date.toISOString().split('T')[0];
        const dateFolderId = await getOrCreateFolder(drive, dateFolderName, parentFolderId);

        // Botごとのフォルダを作成
        const botFolderId = await getOrCreateFolder(drive, botName, dateFolderId);

        const fileName = path.basename(filePath);
        const fileMetadata = {
            name: fileName,
            parents: [botFolderId]
        };
        const media = {
            body: fs.createReadStream(filePath)
        };

        const file = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id'
        });

        console.log(`[${botName}] Successfully uploaded ${fileName} to Google Drive. File ID: ${file.data.id}`);

    } catch (error) {
        console.error(`[${botName}] Error uploading file to Google Drive:`, error);
        throw error; // エラーを再スローして呼び出し元で捕捉できるようにする
    }
}

module.exports = {
    uploadFile
};
