export function scrollToTop(el: HTMLElement, behavior: ScrollBehavior = 'smooth') {
  const top = el.getBoundingClientRect().top - document.body.getBoundingClientRect().top - 100;
  window.scrollTo({ behavior, top });
}
