const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const schedule = require('node-schedule');
const { exec } = require('child_process');
const { GoalNear } = require('mineflayer-pathfinder').goals;
const { createBot, disconnectBot } = require('./src/bot.js');
const { startRecording, stopRecording } = require('./src/recorder.js');
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
const videoFilePath = path.join(__dirname, `${BOT_USERNAME}_${new Date().toISOString().replace(/:/g, '-')}.mp4`);
const memoryFilePath = path.join(__dirname, `kioku_${BOT_USERNAME}.txt`);

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

        // 4. 15分ごとの定例イベントを設定
        const rule = new schedule.RecurrenceRule();
        rule.minute = [0, 15, 30, 45];
        eventScheduler = schedule.scheduleJob(rule, () => runScheduledEvent());

        // 5. 安全なシャットダウンタイマーを設定
        setTimeout(shutdown, SHUTDOWN_TIMER_MS);
        console.log(`[${BOT_USERNAME}] Shutdown timer set for 5.5 hours.`);

    } catch (error) {
        console.error(`[${BOT_USERNAME}] An error occurred during main execution:`, error);
        await shutdown('error');
    }
}

/**
 * Gitコマンドを実行します。
 * @param {string} command - 実行するGitコマンド。
 * @returns {Promise<string>} コマンドの標準出力。
 */
function git(command) {
    return new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error(`Git error: ${stderr}`);
                return reject(error);
            }
            resolve(stdout.trim());
        });
    });
}

/**
 * 15分ごとの定例イベント
 */
async function runScheduledEvent() {
    if (isShuttingDown) return;

    const state = JSON.parse(fsSync.readFileSync('./state.json', 'utf8'));
    if (state.current_part >= 47) {
        console.log(`[${BOT_USERNAME}] Part ${state.current_part}. Grand finale tour time! Skipping regular event.`);
        return;
    }

    console.log(`[${BOT_USERNAME}] It's time for the scheduled event! This marks the end of a part.`);

    // リーダーBot（TekipakiPC）のみがパートを更新
    if (BOT_INDEX === 0) {
        console.log(`[${BOT_USERNAME}] As the leader, updating the part number.`);
        try {
            // state.jsonを読み込み、パート番号をインクリメント
            const statePath = path.join(__dirname, 'state.json');
            const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
            state.current_part += 1;
            await fs.writeFile(statePath, JSON.stringify(state, null, 2));
            console.log(`[${BOT_USERNAME}] Part updated to ${state.current_part}.`);

            // Gitに変更をコミット＆プッシュ
            await git('git pull');
            await git('git add state.json');
            await git(`git commit -m "Update to part ${state.current_part}"`);
            await git('git push');
            console.log(`[${BOT_USERNAME}] Part update successfully pushed to repository.`);

        } catch (error) {
            console.error(`[${BOT_USERNAME}] Failed to update part number:`, error);
        }
    }

    const { x, y, z } = config.behavior.event_coordinates;
    bot.chat(`/say みんな集合！パート${JSON.parse(fsSync.readFileSync('./state.json', 'utf8')).current_part -1}の撮影お疲れ様！座標(${x}, ${y}, ${z})に向かうよ！`);
    // Pathfinderプラグインで集合場所へ移動
    bot.pathfinder.setGoal(new GoalNear(x, y, z, 1));
}

/**
 * 安全なシャットダウン処理
 * @param {string} reason - シャットダウンの理由
 */
async function shutdown(reason = 'scheduled') {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[${BOT_USERNAME}] Shutting down... Reason: ${reason}`);

    // 思考ループとイベントスケジューラを停止
    if (aiInterval) clearInterval(aiInterval);
    if (eventScheduler) eventScheduler.cancel();

    // 録画停止
    await stopRecording();
    console.log(`[${BOT_USERNAME}] Recording stopped.`);

    try {
        // 動画をアップロード
        if (fsSync.existsSync(videoFilePath)) {
            await uploadFile(videoFilePath, BOT_USERNAME);
            fsSync.unlinkSync(videoFilePath); // アップロード後にローカルファイルを削除
            console.log(`[${BOT_USERNAME}] Local video file deleted.`);
        }

        // 記憶ファイルをアップロード
        if (fsSync.existsSync(memoryFilePath)) {
            await uploadFile(memoryFilePath, BOT_USERNAME);
            // 記憶ファイルはGitで管理するため、ローカルでは消さない
        }

    } catch(uploadError) {
        console.error(`[${BOT_USERNAME}] Critical error during file upload:`, uploadError);
        // アップロードに失敗しても、Botの切断とプロセスの終了は試みる
    }

    // Botを切断
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
