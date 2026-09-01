//
//  ViewController.swift
//  ClosiqSync
//
//  Tracked override of the file the Safari web-extension packager generates.
//  build.sh copies it over the generated one, because build/ is regenerated
//  wholesale and nothing edited in place there survives.
//
//  Two additions over Apple's template:
//    1. isInspectable, so the container page can be opened in Safari's Develop
//       menu. Without it a blank WKWebView is a black box and the only way to
//       find out why nothing rendered is to rebuild the whole app per guess.
//    2. Navigation failure logging. A silent failed load is indistinguishable
//       from a page that rendered nothing.
//

import Cocoa
import SafariServices
import WebKit
import os.log

let extensionBundleIdentifier = "com.closiq.ClosiqSync.Extension"

private let log = OSLog(subsystem: "com.closiq.ClosiqSync", category: "container")

class ViewController: NSViewController, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()

        self.webView.navigationDelegate = self
        self.webView.configuration.userContentController.add(self, name: "controller")

        // Debug builds only. Shipping an inspectable webview would let anyone
        // attach to the app, and there is nothing here worth exposing.
        #if DEBUG
        if #available(macOS 13.3, *) {
            self.webView.isInspectable = true
        }
        #endif

        self.webView.loadFileURL(
            Bundle.main.url(forResource: "Main", withExtension: "html")!,
            allowingReadAccessTo: Bundle.main.resourceURL!
        )
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        #if DEBUG
        reportDOM(webView)
        #endif

        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { (state, error) in
            guard let state = state, error == nil else {
                os_log("extension state unavailable: %{public}@",
                       log: log, type: .error, String(describing: error))
                // Leave the page in its neutral state; it already reads as
                // "turn the extension on", which is the right thing to say when
                // we cannot tell.
                return
            }

            DispatchQueue.main.async {
                if #available(macOS 13, *) {
                    webView.evaluateJavaScript("show(\(state.isEnabled), true)")
                } else {
                    webView.evaluateJavaScript("show(\(state.isEnabled), false)")
                }
            }
        }
    }

    /// Ask the page what it actually rendered and log it.
    ///
    /// A WKWebView that shows nothing is otherwise opaque from the outside: the
    /// accessibility tree does not expose web content to external clients, and
    /// screenshots cannot distinguish "no DOM" from "DOM drawn in an invisible
    /// colour". This turns the question into one log line.
    private func reportDOM(_ webView: WKWebView) {
        let js = """
        JSON.stringify({
          kids: document.body ? document.body.children.length : -1,
          textLen: document.body ? document.body.innerText.length : -1,
          scrollH: document.body ? document.body.scrollHeight : -1,
          sheets: document.styleSheets.length,
          bg: document.body ? getComputedStyle(document.body).backgroundColor : null,
          fg: document.body ? getComputedStyle(document.body).color : null,
          h1: document.querySelector('h1')
                ? getComputedStyle(document.querySelector('h1')).display + '/' +
                  document.querySelector('h1').getBoundingClientRect().height
                : 'none'
        })
        """
        webView.evaluateJavaScript(js) { value, error in
            if let error = error {
                os_log("DOM probe failed: %{public}@", log: log, type: .error, error.localizedDescription)
            } else {
                os_log("DOM: %{public}@", log: log, type: .error, String(describing: value))
            }
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        os_log("navigation failed: %{public}@", log: log, type: .error, error.localizedDescription)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        os_log("provisional navigation failed: %{public}@", log: log, type: .error, error.localizedDescription)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? String, body == "open-preferences" else { return }

        SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { error in
            if let error = error {
                os_log("could not open extension preferences: %{public}@",
                       log: log, type: .error, error.localizedDescription)
            }
            DispatchQueue.main.async {
                NSApplication.shared.terminate(nil)
            }
        }
    }
}
