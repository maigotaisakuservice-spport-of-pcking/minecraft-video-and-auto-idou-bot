const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require('fs').promises;
const path = require('path');

// Gemini APIのクライアントを初期化
const API_KEY = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest"});

/**
 * 周囲の状況をテキストとして記述します。
 * @param {mineflayer.Bot} bot - Botのインスタンス。
 * @returns {string} 状況説明テキスト。
 */
function describeSurroundings(bot) {
    const health = `体力: ${bot.health}/20`;
    const food = `満腹度: ${bot.food}/20`;
    const position = `現在座標: (${Math.floor(bot.entity.position.x)}, ${Math.floor(bot.entity.position.y)}, ${Math.floor(bot.entity.position.z)})`;
    const inventory = `持ち物: ${bot.inventory.items().map(item => `${item.name} x${item.count}`).join(', ') || 'なし'}`;
    const nearbyEntities = bot.findPlayers((player) => player.username !== bot.username);
    const players = `近くのプレイヤー: ${nearbyEntities.map(p => p.username).join(', ') || 'なし'}`;

    return [health, food, position, inventory, players].join('\n');
}

/**
 * ファイルの内容を読み込みます。
 * @param {string} filePath - ファイルパス。
 * @returns {Promise<string>} ファイルの内容。
 */
async function readFileContent(filePath) {
    try {
        return await fs.readFile(filePath, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') {
            return ''; // ファイルが存在しない場合は空文字を返す
        }
        throw error;
    }
}

/**
 * AIに次の行動を考えさせ、実行します。
 * @param {mineflayer.Bot} bot - Botのインスタンス。
 */
async function thinkAndAct(bot) {
    console.log(`[${bot.username}] 思考中...`);

    try {
        // 1. 状況認識
        const surroundings = describeSurroundings(bot);

        // 2. 外部ファイルの読み込み
        const statePath = path.join(__dirname, '..', 'state.json');
        const state = JSON.parse(await readFileContent(statePath) || '{ "current_part": 1 }');
        const currentPart = state.current_part;

        const botMemoryPath = path.join(__dirname, '..', `kioku_${bot.username}.txt`);
        const memory = await readFileContent(botMemoryPath);
        const instruction = await readFileContent('sizi.txt');

        const knowledgeDir = 'knowledge';
        const knowledgeFiles = await fs.readdir(knowledgeDir);
        let knowledge = '';
        for (const file of knowledgeFiles) {
            knowledge += await readFileContent(path.join(knowledgeDir, file)) + '\n\n';
        }

        // 3. プロンプトの構築
        let prompt;
        if (currentPart >= 47) {
            // パート47以上の場合は、グランドフィナーレ用の特別プロンプト
            prompt = `
あなたはMinecraftの世界で活動するAI Bot、${bot.username}です。
現在、全48パートのプロジェクトのグランドフィナーレとなるパート${currentPart}の撮影中です。
あなたの任務は、これまでに建設した鉄道網や建築物を視聴者に紹介する「完成お披露目ツアー」を行うことです。

# 現在のあなたの状況
${surroundings}

# ツアーのルール
- 新しい建築や採掘は一切行わないでください。
- トロッコに乗って、これまでに建設した路線を巡り、車窓からの景色を見せてください。
- 各駅で下車し、駅の構造や、駅の周りに建てた建物・オブジェなどを紹介してください。
- 他のBotと協力して、楽しいツアーにしてください。例えば、一人が案内役、もう一人が乗客役になるのも良いでしょう。
- あなたの行動はすべて視聴者への紹介です。「/say こちらが中央駅です。見てください、このガラス張りの天井が自慢です！」のように、常に視聴者に語りかけるように発言してください。
- 最終的な行動は、必ず "/say" や "/tp"、"/goto" などのチャットコマンド形式で、一つだけ出力してください。

# あなたの次の行動
`;
        } else {
            // 通常の建設フェーズのプロンプト
            prompt = `
あなたはMinecraftの世界で活動する自律型AI Botです。あなたの名前は ${bot.username} です。
以下の情報を基に、次に取るべき行動を具体的に一つだけ、チャットコマンドの形式で出力してください。

# あなたの現在の状況
${surroundings}
**プロジェクトの進捗:** 現在、全48パート中のパート${currentPart}の撮影中です。

# あなたの記憶 (過去の行動と思考)
${memory || 'まだ記憶はありません。'}

# 管理者からの指示
${instruction || '特別な指示はありません。'}

# あなたが持つ知識
${knowledge || '特別な知識はありません。'}

# 行動のルール
- 生き残ることを最優先してください。体力が減ったら安全な場所で回復し、お腹が空いたら食事をしてください。
- 管理者からの指示がある場合は、それに従うように努力してください。
- 最終的な行動は、必ず "/say" または "/goto" などのMinecraftのチャットコマンド形式で、一つだけ出力してください。
- 例: "/say こんにちは！" や "/goto 100 64 200"
- 何をすべきか明確でない場合は、周囲を探索するために "/say 周囲を探索します" のように発言してください。

# あなたの次の行動
`;
        }
        // 4. Gemini APIにリクエストを送信
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const action = response.text().trim();
        console.log(`[${bot.username}] AIの判断: ${action}`);

        // 5. 行動の実行と記憶の更新
        if (action.startsWith('/')) {
            bot.chat(action.slice(1)); // スラッシュを除いてコマンド実行
        } else {
            bot.chat(action); // コマンドでない場合はそのまま発言
        }

        const newMemory = `${new Date().toISOString()}: [思考] ${prompt}\n[行動] ${action}\n\n`;
        await fs.appendFile(botMemoryPath, newMemory);

    } catch (error) {
        console.error(`[${bot.username}] 思考中にエラーが発生しました:`, error);
        bot.chat('思考中にエラーが発生しました。');
    }
}

module.exports = {
    thinkAndAct
};
