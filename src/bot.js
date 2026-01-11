const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const fs = require('fs');

// 設定ファイルを読み込む
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

/**
 * Botを生成し、サーバーに接続します。
 * @param {string} username - Botのユーザー名。
 * @returns {Promise<mineflayer.Bot>} Botのインスタンスを返すPromise。
 */
function createBot(username) {
  return new Promise((resolve, reject) => {
    console.log(`[${username}] Connecting to ${config.minecraft.server_host}...`);

    const bot = mineflayer.createBot({
      host: config.minecraft.server_host,
      port: config.minecraft.server_port,
      username: username,
      version: config.minecraft.version,
      auth: 'offline' // オフラインモード
    });

    // イベントリスナー
    bot.once('spawn', () => {
      console.log(`[${username}] Spawned successfully.`);

      // Pathfinderプラグインをロード
      bot.loadPlugin(pathfinder);
      const mcData = require('minecraft-data')(bot.version);
      const defaultMove = new Movements(bot, mcData);
      bot.pathfinder.setMovements(defaultMove);

      console.log(`[${username}] Pathfinder plugin loaded.`);
      resolve(bot);
    });

    bot.on('error', (err) => {
      console.error(`[${username}] Error occurred:`, err);
      reject(err);
    });

    bot.on('kicked', (reason) => {
      console.log(`[${username}] Kicked from server. Reason:`, reason);
      reject(new Error(`Kicked: ${reason}`));
    });

    bot.on('end', (reason) => {
        console.log(`[${username}] Disconnected. Reason: ${reason}`);
    });
  });
}

/**
 * Botをサーバーから切断します。
 * @param {mineflayer.Bot} bot - 切断するBotのインスタンス。
 */
function disconnectBot(bot) {
    if (bot) {
        console.log(`[${bot.username}] Disconnecting...`);
        bot.quit();
    }
}

// モジュールとして関数をエクスポート
module.exports = {
  createBot,
  disconnectBot
};
