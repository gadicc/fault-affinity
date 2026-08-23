// mini-wasm-finite.mjs — bounded reduced WebAssembly churn trigger.
//
// Same fresh-module lifecycle as mini-wasm-churn.mjs (a trailing custom
// section carrying the round number defeats V8's wasm module cache), but runs
// an exact number of rounds and then terminates naturally with exit 0. A
// silent-corruption mismatch exits 43. There is no survival window: an outer
// supervision deadline is never a clean observation.
//
// Usage: taskset -c CPU node mini-wasm-finite.mjs [rounds] [spins] [log-every]

const base = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic, version
  // type section: type0 (i32)->i32 (spin), type1 ()->() (bump)
  0x01, 0x09, 0x02, 0x60, 0x01, 0x7f, 0x01, 0x7f, 0x60, 0x00, 0x00,
  // function section: func0=type0, func1=type1
  0x03, 0x03, 0x02, 0x00, 0x01,
  // memory section: 1 page, no max
  0x05, 0x03, 0x01, 0x00, 0x01,
  // export section: "spin"=func0, "mem"=memory0
  0x07, 0x0e, 0x02, 0x04, 0x73, 0x70, 0x69, 0x6e, 0x00, 0x00, 0x03, 0x6d,
  0x65, 0x6d, 0x02, 0x00,
  // code section
  0x0a, 0x2f, 0x02,
  // func0 spin(n)->i32: block; loop; br_if exit if n==0; call bump; n--;
  // br loop; end; end; return mem[0]
  0x1d, 0x00, 0x02, 0x40, 0x03, 0x40, 0x20, 0x00, 0x45, 0x0d, 0x01, 0x10,
  0x01, 0x20, 0x00, 0x41, 0x01, 0x6b, 0x21, 0x00, 0x0c, 0x00, 0x0b, 0x0b,
  0x41, 0x00, 0x28, 0x02, 0x00, 0x0b,
  // func1 bump(): mem[0] = mem[0] + 1
  0x0f, 0x00, 0x41, 0x00, 0x41, 0x00, 0x28, 0x02, 0x00, 0x41, 0x01, 0x6a,
  0x36, 0x02, 0x00, 0x0b,
]);

const ROUNDS = Number(process.argv[2] || 200);
const SPINS = Number(process.argv[3] || 200000);
const LOG_EVERY = Number(process.argv[4] || 1000);

if (!Number.isSafeInteger(ROUNDS) || ROUNDS < 1 || !Number.isSafeInteger(SPINS) ||
    SPINS < 1 || !Number.isSafeInteger(LOG_EVERY) || LOG_EVERY < 1) {
  console.error("usage: mini-wasm-finite.mjs [rounds] [spins] [log-every]");
  process.exit(2);
}

for (let round = 1; round <= ROUNDS; round += 1) {
  // Fresh module bytes each round: trailing custom section "r" = round number.
  const buf = new Uint8Array(base.length + 8);
  buf.set(base);
  buf.set(
    [
      0x00, 0x06, 0x01, 0x72, round & 0xff, (round >> 8) & 0xff,
      (round >> 16) & 0xff, (round >> 24) & 0xff,
    ],
    base.length,
  );
  const inst = new WebAssembly.Instance(new WebAssembly.Module(buf));
  const got = inst.exports.spin(SPINS) >>> 0;
  if (got !== SPINS >>> 0) {
    console.error(
      `DATA MISMATCH round=${round} expected=${SPINS} got=${got} (silent corruption)`,
    );
    process.exit(43);
  }
  if (round % LOG_EVERY === 0) console.error(`round=${round} ok`);
}
console.error(`rounds=${ROUNDS} complete`);
