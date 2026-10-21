// A glob matched against an absolute path written with forward slashes.
// It covers what a list of excluded files uses: ** (any folders), * (anything inside one name),
// ? (one character), {a,b} and [abc]. Nothing is read from disk; only the two strings are compared.
//
// A pattern is a line of a settings file in a scanned repository: data of unknown shape. It is
// never handed to a regular expression. A pattern that a regular expression would refuse (a range
// written backwards) would stop the check, and one that it would search for minutes ("**/" ten
// times over) would hold it up; here every pattern is walked once along the path, and one that
// describes nothing matches nothing.

// What a pattern is made of, read from left to right:
//   { text }           these characters, as they are
//   { one: true }      one character of a name ("?")
//   { set, negated }   one character of a name that is, or is not, in a set ("[abc]", "[!a-z]")
//   { name: true }     anything inside one name ("*")
//   { any: true }      anything at all ("**")
//   { folders: true }  no folder, or any folders with their slash ("**/")
//   { group }          one of several patterns ("{a,b}")
function parse(pattern) {
  const tokens = [];
  const literal = (char) => {
    const last = tokens[tokens.length - 1];
    if (last && last.text !== undefined) last.text += char;
    else tokens.push({ text: char });
  };
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        // "**/" also matches no folder at all: "**/notes.md" matches "/notes.md".
        if (pattern[index + 1] === '/') {
          index += 1;
          tokens.push({ folders: true });
        } else tokens.push({ any: true });
      } else tokens.push({ name: true });
    } else if (char === '?') tokens.push({ one: true });
    else if (char === '[') {
      const close = pattern.indexOf(']', index + 1);
      if (close === -1) literal(char);
      else {
        const inside = [...pattern.slice(index + 1, close)];
        const negated = inside[0] === '!' || inside[0] === '^';
        const members = negated ? inside.slice(1) : inside;
        const set = [];
        for (let at = 0; at < members.length; at += 1) {
          // "a-z" is a range; a range written backwards holds nothing.
          if (members[at + 1] === '-' && at + 2 < members.length) {
            set.push([members[at], members[at + 2]]);
            at += 2;
          } else set.push([members[at], members[at]]);
        }
        tokens.push({ set, negated });
        index = close;
      }
    } else if (char === '{') {
      const close = pattern.indexOf('}', index + 1);
      if (close === -1) literal(char);
      else {
        tokens.push({ group: pattern.slice(index + 1, close).split(',').map(parse) });
        index = close;
      }
    } else literal(char);
  }
  return tokens;
}

const inSet = (token, char) => token.set.some(([from, to]) => char >= from && char <= to) !== token.negated;

// Where in the text a match of the tokens can end, for every place it can start: `starts` and
// the result are lists of yes and no, one entry per position in the text. Each token is one
// pass over the text, so the work is the length of the pattern times the length of the path.
function walk(tokens, text, starts) {
  let reach = starts;
  for (const token of tokens) {
    const next = new Array(text.length + 1).fill(false);
    if (token.text !== undefined) {
      for (let at = 0; at + token.text.length <= text.length; at += 1) {
        if (reach[at] && text.startsWith(token.text, at)) next[at + token.text.length] = true;
      }
    } else if (token.one || token.set) {
      for (let at = 0; at < text.length; at += 1) {
        if (reach[at] && text[at] !== '/' && (token.one || inSet(token, text[at]))) next[at + 1] = true;
      }
    } else if (token.name || token.any) {
      for (let at = 0; at <= text.length; at += 1) {
        next[at] = reach[at] || (at > 0 && next[at - 1] && (token.any || text[at - 1] !== '/'));
      }
    } else if (token.folders) {
      let started = false;
      for (let at = 0; at <= text.length; at += 1) {
        next[at] = reach[at] || (started && text[at - 1] === '/');
        started ||= reach[at];
      }
    } else {
      for (const option of token.group) {
        walk(option, text, reach).forEach((ends, at) => {
          if (ends) next[at] = true;
        });
      }
    }
    reach = next;
  }
  return reach;
}

const startOnly = (text) => {
  const starts = new Array(text.length + 1).fill(false);
  starts[0] = true;
  return starts;
};

// A function that says whether an absolute path matches the glob. On systems whose file names
// ignore letter case, so does the match.
export function globMatcher(pattern, platform = process.platform) {
  const fold = platform === 'win32' || platform === 'darwin' ? (text) => text.toLowerCase() : (text) => text;
  const tokens = parse(fold(pattern.replace(/\\/g, '/')));
  return (file) => {
    const text = fold(file.replace(/\\/g, '/'));
    return walk(tokens, text, startOnly(text))[text.length];
  };
}

// Where a pattern in which "*" stands for any text can end in a text, when it starts at its
// first character: a list of yes and no, one entry per position. `parts` are the texts between
// the stars. The rule of a settings file is read with this, for the same reason as a glob.
export function starEnds(parts, text) {
  const tokens = parts.flatMap((part, index) => [...(index ? [{ any: true }] : []), ...(part === '' ? [] : [{ text: part }])]);
  return walk(tokens, text, startOnly(text));
}
