/**
 * 输入法正在组词时的按键：这时的回车只是把拼音上屏，不能当成提交。
 * Safari 的 compositionend 比 keydown 先到，isComposing 已经是 false，所以还要看 keyCode 229。
 */
export function isImeComposing(e: { nativeEvent: KeyboardEvent; keyCode: number }): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229;
}
