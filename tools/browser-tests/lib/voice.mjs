import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';

export async function startVoiceFixture(work) {
  const audioFile = path.join(work, 'voice-fixture.wav');
  const samples = 16000 * 3, wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * 440 * i / 16000)), 44 + 2 * i);
  fs.writeFileSync(audioFile, wav);
  const hits = [], failures = [];
  let mode = 'ok';
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      assert.equal(req.url, '/v1/recognize'); assert.equal(req.method, 'POST'); assert.equal(req.headers['content-type'], 'audio/wav');
      assert.equal(body.toString('ascii', 0, 4), 'RIFF'); assert.equal(body.toString('ascii', 8, 16), 'WAVEfmt ');
      assert.equal(body.readUInt32LE(4), body.length - 8); assert.equal(body.readUInt32LE(16), 16);
      assert.equal(body.readUInt16LE(20), 1); assert.equal(body.readUInt16LE(22), 1); assert.equal(body.readUInt32LE(24), 16000);
      assert.equal(body.readUInt32LE(28), 32000); assert.equal(body.readUInt16LE(32), 2); assert.equal(body.readUInt16LE(34), 16);
      assert.equal(body.toString('ascii', 36, 40), 'data'); assert.equal(body.readUInt32LE(40), body.length - 44);
      assert.ok(body.length >= 16044 && body.length <= 1920044);
      assert.ok(body.subarray(44).some(value => value !== 0), 'fake microphone produces actual PCM');
      hits.push({ samples: (body.length - 44) / 2 });
      res.writeHead(mode === 'busy' ? 503 : mode === 'unavailable' ? 500 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(mode === 'ok' ? { text: '语音夹具文字', private: 'ASR_PRIVATE' } : mode === 'empty' ? { text: '  ' } : { error: 'ASR_PRIVATE' }));
    } catch (error) {
      failures.push(error.message); res.writeHead(500); res.end('{}');
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { audioFile, hits, failures, baseUrl: `http://127.0.0.1:${server.address().port}`,
    setMode(value) { mode = value; }, async stop() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
