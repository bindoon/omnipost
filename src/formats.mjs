/** HTML preparation for WeChat and X article drafts. */
export function prepareForWechat(root, { images = true } = {}) {
  const prepared = root.cloneNode(true);
  prepared.querySelector('[data-md-h="1"]')?.remove();
  if (!images) prepared.querySelectorAll('img').forEach((img) => {
    const paragraph = img.closest('p');
    if (paragraph && !paragraph.textContent.trim()) paragraph.remove();
    else img.remove();
  });
  return prepared;
}

export function prepareForX(root) {
  const prepared = root.cloneNode(true);
  prepared.querySelectorAll('img').forEach((img) => {
    const paragraph = img.closest('p');
    if (paragraph && !paragraph.textContent.trim()) paragraph.remove();
    else img.remove();
  });
  prepared.querySelectorAll('[data-md-h]').forEach((heading) => {
    const depth = Number(heading.getAttribute('data-md-h'));
    if (depth === 1) { heading.remove(); return; }
    const replacement = prepared.ownerDocument.createElement(depth <= 3 ? 'h' + depth : 'p');
    replacement.innerHTML = heading.innerHTML;
    heading.replaceWith(replacement);
  });
  prepared.querySelectorAll('*').forEach((el) => {
    for (const attribute of [...el.attributes]) {
      if (el.tagName === 'A' && attribute.name === 'href') continue;
      el.removeAttribute(attribute.name);
    }
  });
  prepared.querySelectorAll('p').forEach((p) => {
    if (!p.textContent.trim() && !p.querySelector('img,video')) p.remove();
  });
  return prepared;
}
