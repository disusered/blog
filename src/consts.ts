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
