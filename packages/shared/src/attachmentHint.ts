/**
 * Words that say a file comes with the message, in a few common languages. Matched as whole words (letters on either
 * side break a match), case-insensitively.
 */
const WORDS = [
  // English
  "attach", "attached", "attaching", "attachments?", "enclosed", "enclosures?",
  // Swedish
  "bifoga[drt]?", "bifogade", "bilaga", "bilagan", "bilagor(?:na)?",
  // Norwegian, Danish
  "vedlagt", "vedlagte", "vedlegg(?:et)?", "vedhæftet", "vedhæftede", "bilag(?:et)?",
  // German
  "anhang", "angehängt", "anbei", "beigefügt",
  // Dutch
  "bijlage", "bijgevoegd",
  // French
  "pièces? jointes?", "ci-joint", "ci-jointe",
  // Spanish, Portuguese, Italian
  "adjunto", "adjunta", "adjuntos", "adjuntado", "anexo", "anexado", "anexos", "allegato", "allegata", "allegati", "in allegato",
  // Finnish
  "liite", "liitteenä", "liitteessä", "liitteet",
];
const RE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${WORDS.join("|")})(?![\\p{L}\\p{N}])`, "iu");

/** True when the text mentions an attachment ("attached", "bifogad", ...). Pass only what the person wrote, not quoted text. */
export const mentionsAttachment = (text: string) => RE.test(text);
