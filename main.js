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
let recordingCycleInterval;
let isShuttingDown = false;
let videoFilePath = path.join(__dirname, `${BOT_USERNAME}_${new Date().toISOString().replace(/:/g, '-')}_part1.mp4`);
const memoryFilePath = path.join(__dirname, `kioku_${BOT_USERNAME}.txt`);
let recordingPart = 1;

/**
 * 動画ファイルを非同期でアップロードし、ローカルファイルを削除します。
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

        // 2. 録画開始
        await startRecording(bot, videoFilePath);

        // 3. AI思考ループを開始 (5分ごと)
        // 初回はすぐに実行
        thinkAndAct(bot);
        aiInterval = setInterval(() => thinkAndAct(bot), 5 * 60 * 1000);

        // 4. 1分ごとの録画サイクルを開始 (テスト用)
        const RECORDING_CYCLE_MS = 1 * 60 * 1000;
        recordingCycleInterval = setInterval(runRecordingCycle, RECORDING_CYCLE_MS);
        console.log(`[${BOT_USERNAME}] [TEST MODE] Recording cycle started. New video part every 1 minute.`);

        // 5. 毎分ごとの定例イベントを設定 (テスト用)
        const rule = new schedule.RecurrenceRule();
        // rule.minute = [0, 15, 30, 45]; // 本番用
        rule.second = 0; // テスト用に毎分実行
        eventScheduler = schedule.scheduleJob(rule, () => runThumbnailEvent());

        // 6. 安全なシャットダウンタイマーを設定
        setTimeout(shutdown, SHUTDOWN_TIMER_MS);
        console.log(`[${BOT_USERNAME}] Shutdown timer set for 5.5 hours.`);

    } catch (error) {
        console.error(`[${BOT_USERNAME}] An error occurred during main execution:`, error);
        await shutdown('error');
    }
}

/**
 * 15分ごとに録画を区切り、アップロードを開始します。
 */
async function runRecordingCycle() {
    if (isShuttingDown) return;
    console.log(`[${BOT_USERNAME}] Cycling recording...`);

    recordingPart++;
    const newVideoFilePath = path.join(__dirname, `${BOT_USERNAME}_${new Date().toISOString().replace(/:/g, '-')}_part${recordingPart}.mp4`);

    try {
        const completedVideoPath = await cycleRecording(bot, newVideoFilePath);
        videoFilePath = newVideoFilePath; // Update global path to the new file

        // Start upload in the background (fire and forget)
        uploadVideoAndCleanup(completedVideoPath);

    } catch (error) {
        console.error(`[${BOT_USERNAME}] Error during recording cycle:`, error);
        // Attempt to restart recording in case of error
        try {
            await startRecording(bot, newVideoFilePath);
            videoFilePath = newVideoFilePath;
        } catch (restartError) {
             console.error(`[${BOT_USERNAME}] CRITICAL: Failed to restart recording after cycle error. Shutting down.`, restartError);
             await shutdown('recording_cycle_failure');
        }
    }
}

/**
 * 15分ごとのサムネイル撮影イベント
 */
async function runThumbnailEvent() {
    if (isShuttingDown) return;

    console.log(`[${BOT_USERNAME}] It's time for the scheduled thumbnail event.`);

    const { x, y, z } = config.behavior.event_coordinates;
    const currentPos = bot.entity.position.clone();

    bot.chat(`/say みんな、15分経過！サムネイル撮影のために一度集合するよー！`);

    try {
        // Teleport, take screenshot, return
        await bot.chat(`/tp ${BOT_USERNAME} ${x} ${y} ${z}`);
        await new Promise(resolve => setTimeout(resolve, 5000));

        const thumbnailPath = path.join(__dirname, `thumbnail_${new Date().toISOString().replace(/:/g, '-')}.png`);
        console.log(`[${BOT_USERNAME}] Taking thumbnail screenshot: ${thumbnailPath}`);
        await takeScreenshot(thumbnailPath);

        // Upload thumbnail in the background
        uploadVideoAndCleanup(thumbnailPath);

        await bot.chat(`/tp ${BOT_USERNAME} ${currentPos.x} ${currentPos.y} ${currentPos.z}`);
        console.log(`[${BOT_USERNAME}] Teleported back to original position.`);

    } catch (error) {
        console.error(`[${BOT_USERNAME}] An error occurred during thumbnail event:`, error);
        bot.chat('サムネイル撮影に失敗しちゃったみたい…。');
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
    if (recordingCycleInterval) clearInterval(recordingCycleInterval);
    if (eventScheduler) eventScheduler.cancel();

    // Stop recording, which finalizes the last video file
    await stopRecording();
    console.log(`[${BOT_USERNAME}] Recording stopped. Final video part is: ${videoFilePath}`);

    try {
        // Upload the very last video part
        await uploadVideoAndCleanup(videoFilePath);

        // Upload memory file
        if (fsSync.existsSync(memoryFilePath)) {
            await uploadFile(memoryFilePath, BOT_USERNAME);
        }

    } catch(uploadError) {
        console.error(`[${BOT_USERNAME}] Critical error during final file upload:`, uploadError);
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
