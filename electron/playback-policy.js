function shouldEmbedMpv(platform = process.platform, env = process.env) {
  return platform === 'win32' && env.MPV_EMBED === '1'
}

module.exports = { shouldEmbedMpv }
