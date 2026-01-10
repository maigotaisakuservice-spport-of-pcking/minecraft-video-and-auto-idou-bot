const Xvfb = require('xvfb');
const { spawn } = require('child_process');
const { viewer: createViewer } = require('prismarine-viewer');
const fs = require('fs');

// 設定ファイルを読み込む
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

let xvfb;
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
        const display = process.env.DISPLAY || ':99';

        console.log(`[${bot.username}] Starting virtual display...`);
        xvfb = new Xvfb({
            displayNum: 99,
            silent: true,
            reuse: true,
            xvfb_args: ["-screen", "0", `${width}x${height}x24`, "-ac"],
        });

        xvfb.start((err) => {
            if (err) {
                console.error(`[${bot.username}] Failed to start Xvfb:`, err);
                return reject(err);
            }

            console.log(`[${bot.username}] Virtual display started on ${display}.`);
            console.log(`[${bot.username}] Starting viewer...`);

            // Viewerを起動
            viewer = createViewer(bot, {
                'view-distance': 'far',
                width: width,
                height: height,
                port: 0, // ポートを0にすると自動で利用可能なポートを選択
                version: bot.version
            });

            console.log(`[${bot.username}] Starting ffmpeg for recording...`);
            const ffmpegArgs = [
                '-f', 'x11grab',
                '-s', `${width}x${height}`,
                '-r', fps.toString(),
                '-i', display,
                '-c:v', 'libx264',
                '-preset', 'ultrafast',
                '-pix_fmt', 'yuv420p',
                '-y', // Overwrite output file if it exists
                outputFile
            ];

            ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: 'ignore' });

            ffmpeg.on('error', (err) => {
                console.error(`[${bot.username}] FFMPEG error: `, err);
                // Don't reject here as it might be a warning
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
            ffmpeg.kill('SIGINT'); // Gracefully stop ffmpeg
            ffmpeg.on('close', () => {
                console.log('ffmpeg stopped.');
                if (xvfb) {
                    xvfb.stop((err) => {
                        if (err) console.error('Failed to stop Xvfb:', err);
                        else console.log('Xvfb stopped.');
                        resolve();
                    });
                } else {
                    resolve();
                }
            });
        } else if (xvfb) {
             xvfb.stop((err) => {
                if (err) console.error('Failed to stop Xvfb:', err);
                else console.log('Xvfb stopped.');
                resolve();
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
