import { createReadStream } from 'node:fs';

// Assemble each complete JSONL line once, including its exact newline bytes. A huge image/tool line
// must not cause quadratic Buffer.concat copying. Incomplete final appends wait for the next scan.
export async function* completeLines(file, start = 0, end) {
  const stream = createReadStream(file, { start, ...(end === undefined ? {} : { end }) });
  let pieces = [], length = 0;
  try {
    for await (const chunk of stream) {
      let from = 0, end;
      while ((end = chunk.indexOf(10, from)) !== -1) {
        const piece = chunk.subarray(from, end + 1);
        pieces.push(piece); length += piece.length;
        yield pieces.length === 1 ? piece : Buffer.concat(pieces, length);
        pieces = []; length = 0; from = end + 1;
      }
      if (from < chunk.length) { const tail = chunk.subarray(from); pieces.push(tail); length += tail.length; }
    }
  } finally { stream.destroy(); }
}
