// Settings can hold credentials inside permission rules, and front matter can quote them. Anything
// that looks like one is replaced before the text leaves the scanner, so it reaches neither the
// console, the model nor a report. Hook commands get a stronger treatment in lib/hooks.mjs.
//
// These are patterns, so they recognise shapes, not secrets: a short password passed as a plain
// positional argument looks like any other word and is not caught here.

export const MASK = '***';

const NAME = 'token|secret|password|passwd|pass|pwd|api[-_]?key|access[-_]?key|auth|credential';
const VALUE = '"[^"]*"|\'[^\']*\'|[^\\s"\'&]+';
const KEY_CHARS = 'A-Za-z0-9+/_=-';

const RULES = [
  // user:password@ (or a lone token@) in a URL
  [/(:\/\/)[^\s/@]+@/g, `$1${MASK}@`],
  // --token VALUE, --api-key=VALUE, --password "two words"
  [new RegExp(`((?<![\\w-])--?[\\w-]*(?:${NAME})[\\w-]*)(\\s+|\\s*[=:]\\s*)(?:${VALUE})`, 'gi'), `$1$2${MASK}`],
  // token=VALUE, "api_key": "VALUE", password: VALUE
  [/((?:token|secret|password|passwd|api[-_]?key|access[-_]?key|credential)s?["']?\s*[=:]\s*["']?)([^\s"'&]+)/gi, `$1${MASK}`],
  // DB_PASS=VALUE, AUTH=VALUE, SIGNING_KEY="VALUE"
  [new RegExp(`(\\b[A-Z0-9_]*(?:PASS|PWD|AUTH|SECRET|TOKEN|KEY)[A-Z0-9_]*=)(?:${VALUE})`, 'g'), `$1${MASK}`],
  // -u user:password, --user user:password
  [/((?<![\w-])(?:-u|--user)\s+)[^\s:"']+:[^\s"']+/g, `$1${MASK}`],
  // -pVALUE, the password flag of database clients
  [/((?<![\w-])-p)(?=[^\s=-])[^\s"']+/g, `$1${MASK}`],
  // Authorization: Basic VALUE, Bearer VALUE
  [/(authorization["']?\s*[:=]\s*["']?\s*(?:basic|bearer|digest)\s+)[^\s"']+/gi, `$1${MASK}`],
  [/(bearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi, `$1${MASK}`],
  // A long run of key characters with a letter and a digit, unless a file extension follows it
  // (a long script name is not a key).
  [
    /(?<![A-Za-z0-9+_=-])(?=[A-Za-z0-9+_=-]*\d)(?=[A-Za-z0-9+_=-]*[A-Za-z])[A-Za-z0-9+_=-]{32,}(?![A-Za-z0-9+_=-])(?!\.[A-Za-z0-9]{1,8}(?![A-Za-z0-9]))/g,
    MASK,
  ],
  // The same with slashes, as base64 keys have them. A path is told apart by how it starts
  // (/, ./, ~/, a drive) and ends (an extension), and a key by mixing digits with both cases.
  [
    new RegExp(
      `(?<![.~:\\\\${KEY_CHARS}])(?=[${KEY_CHARS}]*\\d)(?=[${KEY_CHARS}]*[a-z])(?=[${KEY_CHARS}]*[A-Z])` +
        `(?=[${KEY_CHARS}]*/)[A-Za-z0-9+_=-][${KEY_CHARS}]{31,}(?![.${KEY_CHARS}])`,
      'g',
    ),
    MASK,
  ],
];

export function maskSecrets(text) {
  return RULES.reduce((masked, [pattern, replacement]) => masked.replace(pattern, replacement), text);
}

export function maskDeep(value) {
  if (typeof value === 'string') return maskSecrets(value);
  if (Array.isArray(value)) return value.map(maskDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, maskDeep(entry)]));
  }
  return value;
}
