import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { voiceClient, resample, encodeWav } from '../voice-client.mjs';

test('exported PCM resampler preserves duration and level at microphone sample rates', () => {
  for (const rate of [16000, 44100, 48000]) {
    const samples = resample(new Float32Array(rate).fill(0.5), rate);
    assert.equal(samples.length, 16000);
    assert.ok(samples.every(value => Math.abs(value - 0.5) < 0.00001));
    assert.equal(resample(new Float32Array(Math.floor(rate * 0.753)), rate).length, Math.floor(Math.floor(rate * 0.753) * 16000 / rate));
  }
  assert.deepEqual([...resample(new Float32Array([1, -1, 1, -1, 1, -1]), 48000)], [1 / 3, -1 / 3].map(Math.fround));
  assert.equal(resample(new Float32Array(0), 48000).length, 0);
});

test('exported WAV encoder emits RIFF, mono PCM, 16-bit 16k headers and correct sample data', () => {
  const wav = Buffer.from(encodeWav(resample(new Float32Array(48000).fill(0.5), 48000)));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.toString('ascii', 12, 16), 'fmt '); assert.equal(wav.readUInt32LE(16), 16);
  assert.equal(wav.readUInt32LE(4), wav.length - 8); assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1); assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt32LE(28), 32000); assert.equal(wav.readUInt16LE(32), 2); assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.toString('ascii', 36, 40), 'data'); assert.equal(wav.readUInt32LE(40), 32000);
  for (let at = 44; at < wav.length; at += 2) assert.equal(wav.readInt16LE(at), 16384);
});

test('WAV clips amplitudes to signed 16-bit bounds and supports an empty recording', () => {
  const clipped = Buffer.from(encodeWav(new Float32Array([-2, -1, 0, 1, 2])));
  assert.deepEqual([44, 46, 48, 50, 52].map(at => clipped.readInt16LE(at)), [-32768, -32768, 0, 32767, 32767]);
  const empty = Buffer.from(encodeWav(new Float32Array(0)));
  assert.equal(empty.length, 44); assert.equal(empty.readUInt32LE(4), 36); assert.equal(empty.readUInt32LE(40), 0);
});

test('the complete serialized client is valid JavaScript', () => {
  new Script(voiceClient());
});
