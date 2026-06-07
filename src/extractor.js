// Shared extraction logic. Loaded in the ISOLATED world before content.js,
// so it exposes helpers on a single global namespace for content.js to use.

(function () {
  const STOPWORDS = new Set(
    (
      // --- English function words ---
      "a an and are as at be but by for if in into is it no not of on or such " +
      "that the their then there these they this to was will with i you your my " +
      "me we our us he she him her them his hers its from out up down so just got " +
      "get all any can do does did how what when where who why which more most new " +
      "via vs amp im ive dont cant has have had been being were would could should " +
      "about after again also been before because over under than too very only " +
      // --- Social-media / Instagram filler ---
      "like follow comment share save reel reels video instagram insta subscribe " +
      "link bio watch full part viral trending foryou fyp explore shorts short " +
      "youtube channel guys guy today new check out dm tag tags caption credit " +
      "credits collab collabs page account official original sound audio " +
      // --- Romanized Hindi / Hinglish function words (common noise) ---
      "hai hain ho hota hoti honge tha thi kar karo karne kiya kiye raha rahi rahe " +
      "gaya gayi liye lie wala wali wale kaise kaisa kya kyu kyun kyon nahi nahin " +
      "haan han bhai bhi aur ya par pe se ko ka ki ke me mein mai main hum tum aap " +
      "tu tera mera apna apne ye yeh woh wo is us un jo jab tab ab abhi sab kuch " +
      "kuchh bohot bahut bht bas acha accha achha theek thik matlab waise fir phir " +
      "toh na naa re arre arey yaar yar agar lekin magar sirf bina sath saath ek " +
      "do teen char paanch koi sabhi unka uska iski uski meri teri humare tumhare"
    ).split(/\s+/)
  );

  const VOWELS = /[aeiouàáâãäåèéêëìíîïòóôõöùúûüy]/i;

  // Reject tokens that look like noise rather than words.
  function isNoiseToken(w) {
    if (w.length < 3) return true;
    if (/^\d+$/.test(w)) return true; // pure numbers
    if (/(.)\1\1/.test(w)) return true; // 3+ repeated chars (e.g. "loool")
    if (!VOWELS.test(w)) return true; // no vowel -> not a real word
    return false;
  }

  // Walk an arbitrary JSON payload and collect anything that looks like a reel.
  function extractReels(payload) {
    const found = new Map(); // id -> reel
    const seen = new Set();

    function looksLikeMedia(o) {
      if (!o || typeof o !== "object") return false;
      const code = o.code || o.shortcode;
      if (!code) return false;
      const isVideo =
        o.media_type === 2 ||
        o.is_video === true ||
        o.product_type === "clips" ||
        (typeof o.__typename === "string" &&
          o.__typename.toLowerCase().includes("video")) ||
        o.video_view_count != null ||
        o.play_count != null ||
        o.ig_play_count != null;
      return isVideo;
    }

    function getCaption(o) {
      if (o.caption && typeof o.caption === "object") return o.caption.text || "";
      if (typeof o.caption === "string") return o.caption;
      const edges =
        o.edge_media_to_caption &&
        o.edge_media_to_caption.edges &&
        o.edge_media_to_caption.edges[0];
      if (edges && edges.node) return edges.node.text || "";
      if (o.accessibility_caption) return o.accessibility_caption;
      return "";
    }

    function getThumb(o) {
      if (o.display_url) return o.display_url;
      if (o.thumbnail_url) return o.thumbnail_url;
      const c =
        o.image_versions2 &&
        o.image_versions2.candidates &&
        o.image_versions2.candidates[0];
      if (c && c.url) return c.url;
      if (o.thumbnail_src) return o.thumbnail_src;
      return "";
    }

    function getViews(o) {
      return (
        o.play_count ??
        o.ig_play_count ??
        o.video_view_count ??
        o.view_count ??
        null
      );
    }

    function getTakenAt(o) {
      // Unix seconds when the reel was posted.
      const t =
        o.taken_at ??
        o.taken_at_timestamp ??
        o.device_timestamp ??
        (o.caption && o.caption.created_at) ??
        null;
      if (t == null) return null;
      const n = Number(t);
      if (!Number.isFinite(n)) return null;
      // Some fields are in ms; normalize to seconds.
      return n > 1e12 ? Math.round(n / 1000) : n;
    }

    function getOwner(o) {
      const u = o.user || o.owner;
      if (u && (u.username || u.pk || u.id)) {
        return {
          username: (u.username || "").toLowerCase(),
          id: String(u.pk || u.id || ""),
        };
      }
      return null;
    }

    function normalize(o) {
      const code = o.code || o.shortcode;
      const id = String(o.pk || o.id || code);
      const caption = getCaption(o);
      const existing = found.get(id);
      // If we've already seen this id, only upgrade when the new copy adds a
      // caption the old one lacked (grid queries often omit captions).
      if (existing && (existing.caption || !caption)) return;

      const owner = getOwner(o);
      found.set(id, {
        id,
        code,
        url: "https://www.instagram.com/reel/" + code + "/",
        caption,
        thumbnail: getThumb(o),
        views: getViews(o),
        takenAt: getTakenAt(o),
        owner: owner ? owner.username : "",
        ownerId: owner ? owner.id : "",
        hashtags: extractHashtags(caption),
        keywords: extractKeywords(caption),
      });
    }

    function walk(node) {
      if (!node || typeof node !== "object") return;
      if (seen.has(node)) return;
      seen.add(node);

      if (looksLikeMedia(node)) normalize(node);

      // Some payloads nest the real media under a `media` field.
      if (node.media && looksLikeMedia(node.media)) normalize(node.media);

      if (Array.isArray(node)) {
        for (const child of node) walk(child);
      } else {
        for (const key in node) {
          try {
            walk(node[key]);
          } catch (_) {}
        }
      }
    }

    try {
      walk(payload);
    } catch (_) {}
    return [...found.values()];
  }

  function extractHashtags(text) {
    if (!text) return [];
    const out = [];
    const re = /#([\p{L}\p{N}_]+)/gu;
    let m;
    while ((m = re.exec(text))) out.push(m[1].toLowerCase());
    return [...new Set(out)];
  }

  function extractKeywords(text) {
    if (!text) return [];
    const cleaned = text
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[#@](\p{L}|\p{N}|_)+/gu, " ") // handled separately as hashtags/mentions
      .replace(/[^\p{L}\p{N}\s]/gu, " ");
    const words = cleaned.split(/\s+/).filter(Boolean);
    const out = [];
    for (const w of words) {
      if (STOPWORDS.has(w)) continue;
      if (isNoiseToken(w)) continue;
      out.push(w);
    }
    return [...new Set(out)];
  }

  // Build keyword/hashtag groups. Each reel contributes a term at most once,
  // so `count` is the document frequency (how many reels mention it). Real
  // topics recur; one-off noise does not, so keywords need to appear in
  // multiple reels to be promoted (relaxed automatically for small profiles).
  function buildGroups(reels) {
    const counts = new Map(); // key -> { term, type, count }
    function bump(term, type) {
      const key = type + ":" + term;
      const cur = counts.get(key) || { term, type, count: 0 };
      cur.count += 1;
      counts.set(key, cur);
    }
    for (const r of reels) {
      for (const h of r.hashtags) {
        // Drop hashtags that are just function words / noise (e.g. #hai, #kya).
        if (STOPWORDS.has(h) || isNoiseToken(h)) continue;
        bump(h, "hashtag");
      }
      for (const k of r.keywords) bump(k, "keyword");
    }

    // Adaptive threshold: with enough reels, demand recurrence to cut noise.
    const total = reels.length;
    const keywordMin = total >= 25 ? 3 : total >= 8 ? 2 : 1;
    const hashtagMin = total >= 30 ? 2 : 1;

    return [...counts.values()]
      .filter((g) =>
        g.type === "hashtag" ? g.count >= hashtagMin : g.count >= keywordMin
      )
      .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term));
  }

  window.IGRF = { extractReels, buildGroups };

  try {
    console.info(
      "[Reel It Quick] extractor v1.2 loaded — " +
        STOPWORDS.size +
        " stopwords (hai filtered: " +
        STOPWORDS.has("hai") +
        ")"
    );
  } catch (_) {}
})();
