import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Command } from 'commander';
import superagent from 'superagent';

const MAX_BODY_SIZE = 10 * 1024 * 1024;   // 10 МБ
const CODE_PATH = /^\/(\d{3})$/;          // дозволений шлях: рівно 3 цифри
const ALLOWED_METHODS = ['GET', 'PUT', 'DELETE'];

// ---------- 1. Параметри командного рядка ----------
const program = new Command();
program
  .helpOption('--help', 'показати довідку')      // звільняємо -h для --host
  .requiredOption('-h, --host <address>', 'адреса, на якій працює сервер')
  .requiredOption('-p, --port <number>', 'порт сервера')
  .requiredOption('-c, --cache <path>', 'тека для кешованих картинок');
program.parse();
const options = program.opts();

const port = Number(options.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  program.error('error: порт має бути цілим числом від 1 до 65535');
}
const cacheDir = path.resolve(options.cache);

// ---------- 2. Допоміжні функції ----------
function cacheFile(code) {
  return path.join(cacheDir, `${code}.jpg`);
}

function sendText(res, status, message, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...extraHeaders });
  res.end(message + '\n');
}

function sendImage(res, data, source) {
  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Content-Length': data.length,
    'X-Image-Source': source,                    // 'cache' або 'http.cat'
  });
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {               // потік як async-ітератор, без колбеків
    size += chunk.length;
    if (size > MAX_BODY_SIZE) {
      const err = new Error('Тіло запиту завелике');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function saveToCache(code, data) {
  const target = cacheFile(code);
  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, target);                // атомарна заміна
  } catch (err) {
    await fs.rm(tmp, { force: true });           // прибираємо сміття
    throw err;
  }
}

async function fetchFromHttpCat(code) {
  try {
    const response = await superagent
      .get(`https://http.cat/${code}`)
      .buffer(true)
      .parse(superagent.parse.image)
      .timeout({ response: 5000, deadline: 15000 });
    const body = response.body;
    return Buffer.isBuffer(body) && body.length > 0 ? body : null;
  } catch (err) {
    console.warn(`http.cat/${code}: ${err.status ?? err.code ?? err.message}`);
    return null;                                 // за вимогою методички -> 404
  }
}

// ---------- 3. Обробники методів ----------
async function handleGet(code, res) {
  try {
    const cached = await fs.readFile(cacheFile(code));
    return sendImage(res, cached, 'cache');      // влучання
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;        // «файлу немає» — це не помилка
  }

  const image = await fetchFromHttpCat(code);    // промах
  if (!image) return sendText(res, 404, `Картинку для коду ${code} не знайдено`);

  try {
    await saveToCache(code, image);              // спочатку кеш...
  } catch (err) {
    console.error('Не вдалося зберегти в кеш:', err);
  }
  sendImage(res, image, 'http.cat');             // ...потім відповідь
}

async function handlePut(code, req, res) {
  const body = await readBody(req);
  if (body.length === 0) return sendText(res, 400, 'Порожнє тіло: очікується картинка');
  await saveToCache(code, body);
  sendText(res, 201, `Картинку для коду ${code} збережено`);
}

async function handleDelete(code, res) {
  try {
    await fs.unlink(cacheFile(code));
  } catch (err) {
    if (err.code === 'ENOENT') return sendText(res, 404, `У кеші немає картинки ${code}`);
    throw err;
  }
  sendText(res, 200, `Картинку ${code} видалено з кешу`);
}
 
// ---------- 4. Сервер (єдиний дозволений колбек) ----------
const server = http.createServer(async (req, res) => {
  try {
    if (!ALLOWED_METHODS.includes(req.method)) {
      return sendText(res, 405, 'Метод не підтримується', { Allow: ALLOWED_METHODS.join(', ') });
    }

    const { pathname } = new URL(req.url, 'http://localhost');
    const match = CODE_PATH.exec(pathname);
    if (!match) return sendText(res, 404, 'Очікується шлях виду /404');
    const code = match[1];

    if (req.method === 'GET') return await handleGet(code, res);
    if (req.method === 'PUT') return await handlePut(code, req, res);
    return await handleDelete(code, res);
  } catch (err) {
    console.error(err);
    if (res.headersSent) { res.destroy(); return; }
    const status = err.status ?? 500;
    sendText(res, status, status === 500 ? 'Внутрішня помилка сервера' : err.message);
  }
});

// ---------- 5. Запуск ----------
try {
  await fs.mkdir(cacheDir, { recursive: true });
  server.listen(port, options.host);
  await once(server, 'listening');               // проміс замість колбека listen
  console.log(`Сервер: http://${options.host}:${port}  кеш: ${cacheDir}`);
} catch (err) {
  console.error('Не вдалося запустити сервер:', err.message);
  process.exit(1);
}