import { pipeline } from 'node:stream';

/** Pipe an upstream response and only invalidate the route when the upstream failed. */
export function proxyPipeline(upstream, response, { transform, lost }) {
  let upstreamError;
  upstream.on('error', error => { upstreamError = error; });
  const finished = error => {
    if (!error) return;
    // 客户端离开页面时 pipeline 会以 ERR_STREAM_PREMATURE_CLOSE 结束。
    // 这只表示本次响应被取消，不能把仍然可用的上游标成丢失。
    if (error.code === 'ERR_STREAM_PREMATURE_CLOSE'
      && (response.destroyed || response.closed || response.writableEnded)
      && (!upstreamError || upstreamError.code === 'ERR_STREAM_PREMATURE_CLOSE')) return;
    if (upstreamError) { lost(); return response.destroy(error); }
    response.destroy(error);
  };
  if (transform) pipeline(upstream, transform, response, finished);
  else pipeline(upstream, response, finished);
}
