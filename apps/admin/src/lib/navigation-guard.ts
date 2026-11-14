type Guard = () => boolean;

let guard: Guard | null = null;

/** 当前页面是否允许离开；没有注册守卫时始终允许。 */
export function confirmNavigation(): boolean {
  return guard === null ? true : guard();
}

/** 同一时间只允许一个页面注册守卫（后台一次只编辑一个表单）。 */
export function setNavigationGuard(next: Guard | null): void {
  guard = next;
}
