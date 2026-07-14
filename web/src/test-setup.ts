import "@testing-library/jest-dom/vitest";

// jsdom 不实现 scrollIntoView（长期已知的空缺，非应用逻辑问题）；
// MessageStream 的自动滚动依赖它，测试环境下打个桩即可。
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
