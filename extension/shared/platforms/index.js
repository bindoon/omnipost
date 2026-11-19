import wechat from "./wechat.js";
import xiaohongshu from "./xiaohongshu.js";
import x from "./x.js";
import channels from "./channels.js";
import douyin from "./douyin.js";
import bilibili from "./bilibili.js";
import youtube from "./youtube.js";
import instagram from "./instagram.js";

/**
 * @typedef {object} CopyRules
 * @property {number} titleMax
 * @property {number} [titleMin]
 * @property {number} [bodyMax]
 * @property {boolean} [forbidContact]
 * @property {boolean} [nativeTopics]
 * @property {number} [topicMax]
 * @property {boolean} [tagsFromTopics]
 * @property {number} [tagMax]
 * @property {number} [tagLengthMax]
 * @property {RegExp} [tagForbidden]
 * @property {number} [tagTotalMax]
 *
 * @typedef {object} ScheduleRules
 * @property {boolean} openEditor
 * @property {string} [capability]
 * @property {{minMinutes?: number, maxDays?: number}} [window]
 * @property {string} [submitLabel]
 * @property {RegExp} [receiptPath]
 * @property {boolean} [collectionAfterTime]
 * @property {{statement: string, opener?: string, confirm?: string}} [disclosure]
 *
 * @typedef {object} PlatformRules
 * @property {string} name
 * @property {string} short
 * @property {string} glyph
 * @property {string} color
 * @property {string} url
 * @property {string} caption
 * @property {"direct" | "assist"} automation
 * @property {RegExp[]} [editorPaths]
 * @property {string} [worksUrl]
 * @property {Partial<Record<"article" | "video", CopyRules>>} copy
 * @property {number} [categoryMax]
 * @property {ScheduleRules} [schedule]
 */

/** @type {Record<string, PlatformRules & { kinds: string[] }>} */
export const PLATFORMS = Object.fromEntries(
  Object.entries({
    wechat,
    xiaohongshu,
    x,
    channels,
    douyin,
    bilibili,
    youtube,
    instagram,
  }).map(([id, rules]) => [id, { ...rules, kinds: Object.keys(rules.copy) }]),
);

export const NATIVE_SCHEDULE_CAPABILITY = "native-video-schedule";
export const PLATFORM_SCHEDULE_CAPABILITIES = Object.values(PLATFORMS).flatMap(
  ({ schedule }) => (schedule?.capability ? [schedule.capability] : []),
);
