const profile = process.env.PUBLICATION_PROFILE_JSON
  ? (JSON.parse(process.env.PUBLICATION_PROFILE_JSON) as {
      name: string;
      url: string;
      did: string;
    })
  : undefined;
export const SITE_URL = profile?.url ?? "https://disusered.com";
export const SITE_TITLE = profile?.name ?? "Carlos Antonio";
export const SITE_DESCRIPTION = `Writing by ${SITE_TITLE}`;
export const IS_PERSONAL = SITE_URL === "https://disusered.com";
export const TWITTER_USERNAME = IS_PERSONAL ? "@disusered" : undefined;
export const BLUESKY_URL = profile?.did
  ? `https://bsky.app/profile/${profile.did}`
  : undefined;

/**
 * Hosts whose bare-URL paragraphs render as sandboxed iframes; every other URL
 * stays an ordinary link. The site's own origin is always allowed (see
 * src/embeds.ts) so demos under /demos/ can be shared in posts.
 *
 * Sandbox choices: a third-party frame gets `allow-same-origin` only when its
 * player cannot run without its own storage. That flag grants the frame its own
 * origin, never ours, so it is safe for hosts other than the site itself.
 */
export const EMBED_HOSTS: {
  hosts: string[];
  /** Maps a shared page URL to the URL the host allows in a frame. */
  embed: "youtube" | "codepen";
  sandbox: string;
}[] = [
  {
    hosts: [
      "youtube.com",
      "www.youtube.com",
      "youtu.be",
      "youtube-nocookie.com",
      "www.youtube-nocookie.com",
    ],
    embed: "youtube",
    // The YouTube player refuses to start without its own origin's storage.
    sandbox: "allow-scripts allow-same-origin allow-presentation",
  },
  {
    hosts: ["codepen.io"],
    embed: "codepen",
    sandbox: "allow-scripts allow-presentation",
  },
];
