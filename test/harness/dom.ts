/** Obsidian patches DOM prototypes with these helpers; replicate them for the harness. */

type Opts = {
  cls?: string;
  text?: string;
  attr?: Record<string, string>;
  type?: string;
  value?: string;
  href?: string;
};

function applyOpts(el: HTMLElement, opts?: Opts | string) {
  if (!opts) return el;
  if (typeof opts === "string") {
    el.className = opts;
    return el;
  }
  if (opts.cls) el.className = opts.cls;
  if (opts.text != null) el.textContent = opts.text;
  if (opts.attr) for (const k in opts.attr) el.setAttribute(k, opts.attr[k]);
  if (opts.type) (el as any).type = opts.type;
  if (opts.value != null) (el as any).value = opts.value;
  return el;
}

const proto: any = HTMLElement.prototype;

proto.addClass = function (...cls: string[]) {
  this.classList.add(...cls);
  return this;
};
proto.removeClass = function (...cls: string[]) {
  this.classList.remove(...cls);
  return this;
};
proto.toggleClass = function (cls: string, on?: boolean) {
  if (on === undefined) this.classList.toggle(cls);
  else if (on) this.classList.add(cls);
  else this.classList.remove(cls);
  return this;
};
proto.hasClass = function (cls: string) {
  return this.classList.contains(cls);
};
proto.setText = function (t: string) {
  this.textContent = t;
  return this;
};
proto.empty = function () {
  while (this.firstChild) this.removeChild(this.firstChild);
  return this;
};
proto.createDiv = function (opts?: Opts | string) {
  const el = document.createElement("div");
  applyOpts(el, opts);
  this.appendChild(el);
  return el;
};
proto.createSpan = function (opts?: Opts | string) {
  const el = document.createElement("span");
  applyOpts(el, opts);
  this.appendChild(el);
  return el;
};
proto.createEl = function (tag: string, opts?: Opts | string) {
  const el = document.createElement(tag);
  applyOpts(el, opts);
  this.appendChild(el);
  return el;
};
proto.appendText = function (t: string) {
  this.appendChild(document.createTextNode(t));
  return this;
};
