const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const schedule = require('node-schedule');
const { exec } = require('child_process');
const { createBot, disconnectBot } = require('./src/bot.js');
const { startRecording, stopRecording, takeScreenshot, cycleRecording } = require('./src/recorder.js');
const { thinkAndAct } = require('./src/ai.js');
const { uploadFile } = require('./src/gdrive.js');

// --- 設定 ---
const config = JSON.parse(fsSync.readFileSync('./config.json', 'utf8'));
const BOT_INDEX = parseInt(process.env.BOT_INDEX || '0', 10);
const BOT_USERNAME = config.bots[BOT_INDEX].username;
const SHUTDOWN_TIMER_MS = 5.5 * 60 * 60 * 1000; // 5時間30分

// --- グローバル変数 ---
let bot;
let aiInterval;
let eventScheduler;
let isShuttingDown = false;
let videoFilePath; // 初期化はmain関数で行う
const memoryFilePath = path.join(__dirname, `kioku_${BOT_USERNAME}.txt`);

/**
 * 動画ファイルやサムネイルを非同期でアップロードし、ローカルファイルを削除します。
 * エラーが発生してもプロセスは終了しません。
 * @param {string} filePath - アップロードする動画ファイルのパス。
 */
async function uploadVideoAndCleanup(filePath) {
    if (!fsSync.existsSync(filePath)) {
        console.log(`[${BOT_USERNAME}] Upload skipped: File not found - ${filePath}`);
        return;
    }
    console.log(`[${BOT_USERNAME}] Starting background upload for: ${filePath}`);
    try {
        await uploadFile(filePath, BOT_USERNAME);
        await fs.unlink(filePath);
        console.log(`[${BOT_USERNAME}] Successfully uploaded and deleted: ${filePath}`);
    } catch (error) {
        console.error(`[${BOT_USERNAME}] Error during background upload for ${filePath}:`, error);
    }
}

/**
 * メイン処理
 */
async function main() {
    try {
        // 1. Botの作成とサーバー接続
        bot = await createBot(BOT_USERNAME);

        // 2. state.jsonから現在のパート番号を読み込み、録画を開始
        const state = JSON.parse(await fs.readFile('state.json', 'utf8'));
        const currentPart = state.current_part;
        videoFilePath = path.join(__dirname, `${BOT_USERNAME}_part${currentPart}.mp4`);
        await startRecording(bot, videoFilePath);
        console.log(`[${BOT_USERNAME}] Recording started for part ${currentPart}.`);

        // 3. AI思考ループを開始 (5分ごと)
        // 初回はすぐに実行
        thinkAndAct(bot);
        aiInterval = setInterval(() => thinkAndAct(bot), 5 * 60 * 1000);

        // 4. 統合されたパート管理イベントを設定 (1分ごと - テスト用)
        const rule = new schedule.RecurrenceRule();
        // rule.minute = [0, 15, 30, 45]; // 本番用
        rule.second = 0; // テスト用に毎分実行
        eventScheduler = schedule.scheduleJob(rule, () => runScheduledPartEvent());
        console.log(`[${BOT_USERNAME}] [TEST MODE] Scheduled part event handler is set up to run every minute.`);

        // 5. 安全なシャットダウンタイマーを設定
        setTimeout(shutdown, SHUTDOWN_TIMER_MS);
        console.log(`[${BOT_USERNAME}] Shutdown timer set for 5.5 hours.`);

    } catch (error) {
        console.error(`[${BOT_USERNAME}] An error occurred during main execution:`, error);
        await shutdown('error');
    }
}

/**
 * Gitコマンドを安全に実行します。
 * @param {string} command - 実行するGitコマンド。
 * @returns {Promise<string>} コマンドの標準出力。
 */
function git(command) {
    return new Promise((resolve, reject) => {
        // execに渡す前に、余分なスペースや潜在的なインジェクションのリスクを軽減
        const sanitizedCommand = command.trim().split(' ').filter(Boolean).join(' ');
        exec(`git ${sanitizedCommand}`, (error, stdout, stderr) => {
            if (error) {
                console.error(`Git error for command "git ${sanitizedCommand}": ${stderr}`);
                return reject(new Error(stderr));
            }
            resolve(stdout.trim());
        });
    });
}

/**
 * 15分ごとに実行される、パート管理の統合イベントハンドラ
 */
async function runScheduledPartEvent() {
    if (isShuttingDown) return;
    console.log(`[${BOT_USERNAME}] Starting scheduled part event...`);

    const originalPosition = bot.entity.position.clone();

    try {
        // --- 1. 録画を停止 ---
        await stopRecording();
        console.log(`[${BOT_USERNAME}] Recording stopped for part finalization: ${videoFilePath}`);
        // 古いビデオファイルパスを保持
        const completedVideoPath = videoFilePath;

        // --- 2. 動画のバックグラウンドアップロードを開始 ---
        uploadVideoAndCleanup(completedVideoPath);

        // --- 3. サムネイル撮影 ---
        const stateBeforeUpdate = JSON.parse(await fs.readFile('state.json', 'utf8'));
        const partNumberForThumbnail = stateBeforeUpdate.current_part;
        const thumbnailPath = path.join(__dirname, `thumbnail_part_${partNumberForThumbnail}.png`);

        bot.chat(`/say パート${partNumberForThumbnail} 終了！サムネイル撮るから集合！`);
        const { x, y, z } = config.behavior.event_coordinates;
        await bot.chat(`/tp ${BOT_USERNAME} ${x} ${y} ${z}`);
        await new Promise(resolve => setTimeout(resolve, 5000)); // 描画安定待ち

        await takeScreenshot(thumbnailPath);
        console.log(`[${BOT_USERNAME}] Took thumbnail: ${thumbnailPath}`);
        uploadVideoAndCleanup(thumbnailPath); // サムネイルも非同期アップロード

        // --- 4. パート番号の更新 (リーダーBotのみ) ---
        if (BOT_INDEX === 0) {
            console.log(`[${BOT_USERNAME}] As leader, updating part number...`);
            const state = JSON.parse(await fs.readFile('state.json', 'utf8'));
            state.current_part += 1;
            await fs.writeFile('state.json', JSON.stringify(state, null, 2));

            await git('config --global user.name "GitHub Actions Bot"');
            await git('config --global user.email "github-actions-bot@github.com"');
            await git('pull');
            await git('add state.json');
            await git(`commit -m "Update to part ${state.current_part}"`);
            await git('push');
            console.log(`[${BOT_USERNAME}] Pushed part update to ${state.current_part}.`);
        } else {
            // 他Botはリーダーの更新を待つ
            await new Promise(resolve => setTimeout(resolve, 10000)); // 10秒待機
            await git('pull');
            console.log(`[${BOT_USERNAME}] Pulled latest state.json.`);
        }

        // --- 5. 録画再開 ---
        const newState = JSON.parse(await fs.readFile('state.json', 'utf8'));
        const newPartNumber = newState.current_part;
        videoFilePath = path.join(__dirname, `${BOT_USERNAME}_part${newPartNumber}.mp4`);

        // 元の場所に戻ってから録画再開
        await bot.chat(`/tp ${BOT_USERNAME} ${originalPosition.x} ${originalPosition.y} ${originalPosition.z}`);
        await new Promise(resolve => setTimeout(resolve, 2000)); // テレポート後の安定待ち

        await startRecording(bot, videoFilePath);
        console.log(`[${BOT_USERNAME}] Recording RESTARTED for new part ${newPartNumber}.`);

    } catch (error) {
        console.error(`[${BOT_USERNAME}] CRITICAL ERROR during scheduled part event:`, error);
        bot.chat('パートの切り替え中に大変なエラーが起きたみたい…。');
        // エラーが発生しても、とにかく次の録画を試みる
        try {
            const newState = JSON.parse(await fs.readFile('state.json', 'utf8'));
            const newPartNumber = newState.current_part;
            videoFilePath = path.join(__dirname, `${BOT_USERNAME}_part${newPartNumber}.mp4`);
            await bot.chat(`/tp ${BOT_USERNAME} ${originalPosition.x} ${originalPosition.y} ${originalPosition.z}`);
            await startRecording(bot, videoFilePath);
            console.log(`[${BOT_USERNAME}] Forcefully restarted recording for part ${newPartNumber}.`);
        } catch (recoveryError) {
            console.error(`[${BOT_USERNAME}] FAILED TO RECOVER. Shutting down...`, recoveryError);
            await shutdown('part_event_failure');
        }
    }
}

/**
 * 安全なシャットダウン処理
 * @param {string} reason - シャットダウンの理由
 */
async function shutdown(reason = 'scheduled') {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[${BOT_USERNAME}] Shutting down... Reason: ${reason}`);

    // Stop all intervals and schedulers
    if (aiInterval) clearInterval(aiInterval);
    if (eventScheduler) eventScheduler.cancel();

    // Stop recording, which finalizes the last video file
    await stopRecording();
    console.log(`[${BOT_USERNAME}] Recording stopped. Final video part is: ${videoFilePath}`);

    try {
        // Upload the very last video part
        await uploadVideoAndCleanup(videoFilePath);

        // Commit and push memory file to Git
        if (fsSync.existsSync(memoryFilePath)) {
            console.log(`[${BOT_USERNAME}] Committing memory file to repository...`);
            await git('config --global user.name "GitHub Actions Bot"');
            await git('config --global user.email "github-actions-bot@github.com"');
            await git('pull');
            await git(`add ${path.basename(memoryFilePath)}`);
            await git(`commit -m "Update memory for ${BOT_USERNAME}"`);
            await git('push');
            console.log(`[${BOT_USERNAME}] Memory file pushed to repository.`);
            // Also upload to Google Drive as a backup
            await uploadFile(memoryFilePath, BOT_USERNAME);
        }

    } catch(uploadError) {
        console.error(`[${BOT_USERNAME}] Critical error during final file upload/commit:`, uploadError);
    }

    disconnectBot(bot);
    console.log(`[${BOT_USERNAME}] Shutdown sequence complete.`);
    process.exit(0);
}


// --- プロセスの予期せぬ終了を捕捉 ---
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
    console.error('An uncaught exception occurred:', err);
    shutdown('uncaughtException');
});

// --- 実行開始 ---
main();
