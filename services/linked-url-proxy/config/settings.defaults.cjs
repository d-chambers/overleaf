const blockedNetworks = (process.env.OVERLEAF_LINKED_URL_BLOCKED_NETWORKS || '')
  .split(/[,\s]+/)
  .filter(Boolean)
  .map(cidr => cidr.trim())

const allowedResources = process.env.OVERLEAF_LINKED_URL_ALLOWED_RESOURCES
  ? // anchored at the start so the pattern can't be satisfied by text placed
    // in the query string or path of an otherwise-blocked URL
    new RegExp(`^(?:${process.env.OVERLEAF_LINKED_URL_ALLOWED_RESOURCES})`)
  : null

// Optional: no direct egress. Fetch only through this HTTPS proxy, and only
// URLs starting with one of these prefixes (each should end in "/").
const httpsProxy = process.env.OVERLEAF_LINKED_URL_HTTPS_PROXY || null
const allowedUrlPrefixes = (process.env.OVERLEAF_LINKED_URL_ALLOWED_PREFIXES || '')
  .split(/[,\s]+/)
  .filter(Boolean)

module.exports = {
  httpsProxy,
  allowedUrlPrefixes,
  maxRedirects: 5,
  fetchTimeoutMs: 30000,
  blockedNetworks,
  allowedResources,
  userAgentHeader: {
     'User-Agent': 'Overleaf Extended CE - LinkedURLProxy (https://github.com/yu-i-i/overleaf-cep)'
  },
  maxUploadSize: process.env.MAX_UPLOAD_SIZE
    ? parseInt(process.env.MAX_UPLOAD_SIZE, 10) * 1024 * 1024
    : 50 * 1024 * 1024, // 50 MB
  internal: {
    linkedUrlProxy: {
      port: 3066,
      host: process.env.LINKED_URL_PROXY_HOST || '127.0.0.1',
    },
  },
}
