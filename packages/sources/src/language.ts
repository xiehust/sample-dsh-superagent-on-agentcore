/** dshsa: the language of a notice the agent writes on its own, from the person's request it answers. */

/** Chinese when the request has Han characters and no kana (so Japanese stays English), otherwise English. */
export function prefersChinese(request: string): boolean {
  return /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
}
