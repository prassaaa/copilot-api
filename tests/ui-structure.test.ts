import { describe, expect, test } from "bun:test"

const htmlContent = await Bun.file("./public/index.html").text()
const jsContent = await Bun.file("./public/js/app.js").text()

describe("UI Structure - index.html", () => {
  test("has viewport meta tag", () => {
    expect(htmlContent).toContain('<meta name="viewport"')
    expect(htmlContent).toContain("width=device-width")
  })

  test("sidebar has transition-transform class for mobile animation", () => {
    expect(htmlContent).toContain("transition-transform")
  })

  test("bottom nav has lg:hidden class", () => {
    expect(htmlContent).toContain('class="lg:hidden fixed bottom-0')
  })

  test("confirm dialog template exists with x-show binding", () => {
    expect(htmlContent).toContain('x-show="confirmDialog.show"')
  })

  test("hamburger button exists with lg:hidden class", () => {
    expect(htmlContent).toContain('class="lg:hidden w-12 h-12')
  })

  test("all 8 tab sections exist", () => {
    const tabs = [
      "dashboard",
      "models",
      "usage",
      "accounts",
      "logs",
      "settings",
      "history",
      "playground",
    ]
    for (const tab of tabs) {
      expect(htmlContent).toContain(`activeTab === '${tab}'`)
    }
  })

  test("playground container uses responsive flex direction", () => {
    expect(htmlContent).toContain("grid-cols-1 xl:grid-cols-2")
  })

  test("sidebar has mobile backdrop overlay", () => {
    expect(htmlContent).toContain("Sidebar Backdrop")
    expect(htmlContent).toContain("closeSidebar()")
  })

  test("history has mobile card view", () => {
    expect(htmlContent).toContain("md:hidden space-y-2")
    expect(htmlContent).toContain("hidden md:block overflow-x-auto")
  })

  test("skeleton shimmer CSS is defined", () => {
    expect(htmlContent).toContain("skeleton-shimmer")
    expect(htmlContent).toContain(".skeleton")
  })

  test("smooth scrolling is enabled", () => {
    expect(htmlContent).toContain("scroll-behavior: smooth")
  })

  test("stat cards have intermediate sm breakpoint", () => {
    expect(htmlContent).toContain("sm:grid-cols-3 lg:grid-cols-5")
  })
})

describe("UI Structure - app.js", () => {
  test("has sidebarOpen state", () => {
    expect(jsContent).toContain("sidebarOpen: false")
  })

  test("has confirmDialog state", () => {
    expect(jsContent).toContain("confirmDialog:")
    expect(jsContent).toContain("show: false")
  })

  test("has showConfirm method", () => {
    expect(jsContent).toContain("showConfirm(")
  })

  test("has confirmDialogConfirm method", () => {
    expect(jsContent).toContain("confirmDialogConfirm()")
  })

  test("has confirmDialogCancel method", () => {
    expect(jsContent).toContain("confirmDialogCancel()")
  })

  test("has toggleSidebar method", () => {
    expect(jsContent).toContain("toggleSidebar()")
  })

  test("has closeSidebar method", () => {
    expect(jsContent).toContain("closeSidebar()")
  })

  test("has loadingStates", () => {
    expect(jsContent).toContain("loadingStates:")
  })

  test("no native confirm() calls remain", () => {
    const lines = jsContent.split("\n")
    for (const line of lines) {
      if (
        line.includes("confirmDialog")
        || line.includes("showConfirm")
        || line.includes("confirmDialogConfirm")
        || line.includes("confirmDialogCancel")
      )
        continue
      expect(line).not.toMatch(/(?<![a-zA-Z])confirm\(/)
    }
  })

  test("closeSidebar is called on tab change", () => {
    expect(jsContent).toContain("this.closeSidebar()")
  })
})
