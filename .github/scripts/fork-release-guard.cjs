const assertVersion = (value) => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-nightly\.(\d{8})\.(\d+)(?:-tb(?:\.(\d+))?)?)?$/.exec(
    value,
  );
  if (!match) throw new Error(`Unsupported nightly channel version: ${value}`);
  return [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    match[4] === undefined ? Infinity : Number(match[4]),
    Number(match[5] ?? 0),
    Number(match[6] ?? 0),
  ];
};

function canAdvance(candidate, current) {
  const next = assertVersion(candidate);
  const previous = assertVersion(current);
  for (let index = 0; index < next.length; index++) {
    if (next[index] !== previous[index]) return next[index] > previous[index];
  }
  return true;
}

module.exports = { canAdvance };
if (require.main === module) {
  try {
    console.log(canAdvance(process.argv[2], process.argv[3]));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
