const { spawn } = require('child_process');
const { viewer: createViewer } = require('prismarine-viewer');
const fs = require('fs');

// 設定ファイルを読み込む
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

let ffmpeg;
let viewer;

/**
 * 録画を開始します。
 * @param {mineflayer.Bot} bot - 録画対象のBotインスタンス。
 * @param {string} outputFile - 出力ファイルパス。
 * @returns {Promise<void>}
 */
function startRecording(bot, outputFile) {
    return new Promise((resolve, reject) => {
        const { width, height, fps } = config.recorder;
        // xvfb-runがDISPLAY環境変数を設定してくれるので、それを信じる
        const display = process.env.DISPLAY;

        if (!display) {
            const errMsg = `[${bot.username}] ERROR: DISPLAY environment variable is not set. Please run with xvfb-run.`;
            console.error(errMsg);
            return reject(new Error(errMsg));
        }

        console.log(`[${bot.username}] Starting viewer on display ${display}...`);

        // Viewerを起動
        try {
            viewer = createViewer(bot, {
                'view-distance': 'far',
                width: width,
                height: height,
                port: 0, // 自動で利用可能なポートを選択
                version: bot.version
            });
        } catch (err) {
            console.error(`[${bot.username}] Failed to create viewer:`, err);
            return reject(err);
        }

        console.log(`[${bot.username}] Starting ffmpeg for recording...`);
        const ffmpegArgs = [
            '-f', 'x11grab',
            '-s', `${width}x${height}`,
            '-r', fps.toString(),
            '-i', display,
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-pix_fmt', 'yuv420p',
            '-y', // 出力ファイルが存在すれば上書き
            outputFile
        ];

        ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: 'ignore' });

        ffmpeg.on('error', (err) => {
            console.error(`[${bot.username}] FFMPEG error: `, err);
        });

        ffmpeg.on('exit', (code, signal) => {
            console.log(`[${bot.username}] FFMPEG exited with code: ${code}, signal: ${signal}`);
        });

        // 録画開始を少し待つ
        setTimeout(() => {
            console.log(`[${bot.username}] Recording started. Output to ${outputFile}`);
            resolve();
        }, 2000); // 2秒待機してffmpegの起動を確実にする
    });
}

/**
 * 録画を停止します。
 * @returns {Promise<void>}
 */
function stopRecording() {
    return new Promise((resolve) => {
        if (viewer) {
            viewer.close();
            viewer = null;
            console.log('Viewer closed.');
        }

        if (ffmpeg) {
            console.log('Stopping ffmpeg...');
            ffmpeg.kill('SIGINT'); // ffmpegを正常に停止させる
            ffmpeg.on('close', () => {
                console.log('ffmpeg stopped.');
                resolve(); // Xvfbの管理はしない
            });
        } else {
            resolve();
        }
    });
}

/**
 * スクリーンショットを撮影します。
 * @param {string} outputFile - 出力ファイルパス (PNG)。
 * @returns {Promise<void>}
 */
function takeScreenshot(outputFile) {
    return new Promise((resolve, reject) => {
        if (!viewer) {
            return reject(new Error('Viewer is not running.'));
        }
        try {
            viewer.takeScreenshot(outputFile);
            console.log(`Screenshot saved to ${outputFile}`);
            resolve();
        } catch (err) {
            console.error('Failed to take screenshot:', err);
            reject(err);
        }
    });
}

module.exports = {
    startRecording,
    stopRecording,
    takeScreenshot,
};
