const { spawn } = require('child_process');
const { viewer: createViewer } = require('prismarine-viewer');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

let ffmpeg;
let viewer;
let currentOutputFile;

/**
 * FFMPEGプロセスを開始します (内部関数)
 */
function startFfmpegProcess(bot, outputFile) {
    return new Promise((resolve) => {
        const { width, height, fps } = config.recorder;
        const display = process.env.DISPLAY;

        console.log(`[${bot.username}] Starting ffmpeg for recording... Output: ${outputFile}`);
        const ffmpegArgs = [
            '-f', 'x11grab', '-s', `${width}x${height}`, '-r', fps.toString(), '-i', display,
            '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-y', outputFile
        ];

        ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: 'ignore' });

        ffmpeg.on('error', (err) => console.error(`[${bot.username}] FFMPEG error: `, err));
        ffmpeg.on('exit', (code, signal) => console.log(`[${bot.username}] FFMPEG exited with code: ${code}, signal: ${signal}`));

        setTimeout(() => {
            console.log(`[${bot.username}] Recording process is now running.`);
            resolve();
        }, 2000);
    });
}

/**
 * FFMPEGプロセスを停止します (内部関数)
 */
function stopFfmpegProcess() {
    return new Promise((resolve) => {
        if (ffmpeg) {
            ffmpeg.kill('SIGINT');
            ffmpeg.on('close', () => {
                console.log('ffmpeg process stopped.');
                ffmpeg = null;
                resolve();
            });
        } else {
            resolve();
        }
    });
}

/**
 * Viewerの起動と初回録画を開始します。
 */
async function startRecording(bot, outputFile) {
    const { width, height } = config.recorder;
    const display = process.env.DISPLAY;

    if (!display) {
        const errMsg = `[${bot.username}] ERROR: DISPLAY environment variable is not set. Please run with xvfb-run.`;
        console.error(errMsg);
        throw new Error(errMsg);
    }

    console.log(`[${bot.username}] Starting viewer on display ${display}...`);
    try {
        viewer = createViewer(bot, {
            'view-distance': 'far',
            width: width, height: height, port: 0, version: bot.version
        });
    } catch (err) {
        console.error(`[${bot.username}] Failed to create viewer:`, err);
        throw err;
    }

    currentOutputFile = outputFile;
    await startFfmpegProcess(bot, outputFile);
}

/**
 * 録画をサイクルさせ、古いファイルパスを返します。
 */
async function cycleRecording(bot, newOutputFile) {
    console.log(`[${bot.username}] Cycling recording. New file will be: ${newOutputFile}`);
    const oldOutputFile = currentOutputFile;

    await stopFfmpegProcess();
    console.log(`[${bot.username}] Old recording part has been finalized: ${oldOutputFile}`);

    currentOutputFile = newOutputFile;
    await startFfmpegProcess(bot, newOutputFile);
    console.log(`[${bot.username}] New recording part has started.`);

    return oldOutputFile;
}

/**
 * Viewerと録画を完全に停止します。
 */
async function stopRecording() {
    if (viewer) {
        viewer.close();
        viewer = null;
        console.log('Viewer closed.');
    }
    await stopFfmpegProcess();
}

/**
 * スクリーンショットを撮影します。
 */
function takeScreenshot(outputFile) {
    return new Promise((resolve, reject) => {
        if (!viewer) return reject(new Error('Viewer is not running.'));
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
    cycleRecording,
};
