/**
 * landing 的全部脚本：一个复制按钮。
 * 站点没有框架也没有构建链，这里也不该长出第二个职责。
 */

for (const btn of document.querySelectorAll('[data-copy]')) {
  btn.addEventListener('click', async () => {
    const target = document.querySelector(btn.dataset.copy);
    if (!target) return;
    const text = target.textContent.trim();
    const original = btn.textContent;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = '已复制';
    } catch {
      // 剪贴板被拒（无权限/非安全上下文）时，至少把命令选中让用户自己复制
      const range = document.createRange();
      range.selectNodeContents(target);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      btn.textContent = '已选中，按 ⌘C';
    }
    setTimeout(() => { btn.textContent = original; }, 1_800);
  });
}
