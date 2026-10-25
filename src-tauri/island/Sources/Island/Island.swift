// The orb's island: a notch of Liquid Glass fused to the top edge of the
// screen, under the camera, with Jelly in it and, when there is something to
// say, a few words beside it, drawn by SwiftUI.
//
// Native because that is what makes it smooth. The glass and the words move
// in one SwiftUI animation, on springs that keep their speed when a new
// message interrupts them, inside a panel that is never resized.
//
// Jelly is the orb's web page (public/orb.html), in a fixed box at the left
// of the notch's body: centred at rest, and carried sideways as the notch
// grows to make room for the words. The notch's width is animated by
// SwiftUI, and the same animated width places the box on every frame, so the
// two move as one. The web view stays in the window where Tauri put it, above
// the island. Taking it out of the window, even for a moment, makes WebKit
// drop a window observer the panel no longer knows about, and AppKit ends the
// app.
//
// The app calls two functions, from the main thread: island_install once,
// and island_show whenever the page's picture changes (the orb_view command).

import AppKit
import SwiftUI

/// Sizes in points. orb.css draws Jelly 24 pt in the middle of its box.
private enum Size {
    /// The notch's height, at rest and speaking: it only grows sideways.
    static let height: CGFloat = 32
    static let jellyBox: CGFloat = 32
    /// Either side of Jelly at rest, then between Jelly's box and its words,
    /// and after them.
    static let side: CGFloat = 12
    static let gap: CGFloat = 2
    static let end: CGFloat = 16
    static let rest: CGFloat = side + jellyBox + side
    static let maxWidth: CGFloat = 360
    static let radius: CGFloat = 12
    /// The curve where the notch flares into the top edge.
    static let ear: CGFloat = 8
    static let font = NSFont.systemFont(ofSize: 13, weight: .semibold)
}

/// Opening has a little give; closing settles without bouncing.
private let opening = Animation.spring(response: 0.42, dampingFraction: 0.8)
private let closing = Animation.spring(response: 0.45, dampingFraction: 1.0)

final class IslandModel: ObservableObject {
    @Published var pill = false
    @Published var tone = "off"
    @Published var words = ""
    /// The notch's body, without its flares.
    @Published var width = Size.rest
    @Published var label = "Gesture"
    /// Where the island is in the panel, top-left origin, for passing clicks.
    var frame = CGRect.zero
}

// ------------------------------------------------------------------ the view

private struct IslandView: View {
    @ObservedObject var model: IslandModel
    let onClick: () -> Void

    var body: some View {
        island.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    private var island: some View {
        let shape = Notch(radius: Size.radius, ear: Size.ear)
        return HStack(spacing: 0) {
            // Jelly's place. Its page is kept over this.
            Color.clear.frame(width: Size.jellyBox, height: Size.height)
            if model.pill {
                Text(model.words)
                    .font(Font(Size.font))
                    .lineLimit(1)
                    .contentTransition(.opacity)
                    .padding(.leading, Size.gap)
                    .transition(.asymmetric(
                        insertion: .opacity.animation(.easeOut(duration: 0.18).delay(0.12)),
                        removal: .opacity.animation(.easeIn(duration: 0.1))
                    ))
            }
            Spacer(minLength: 0)
        }
        .padding(.leading, Size.side)
        .modifier(BodyWidth(width: model.width))
        .padding(.horizontal, Size.ear)
        .background(alignment: .topLeading) { light }
        .clipShape(shape)
        .islandGlass(shape)
        .contentShape(shape)
        .onTapGesture(perform: onClick)
        .background(GeometryReader { geometry in
            Color.clear
                .onAppear { model.frame = geometry.frame(in: .global) }
                .onChange(of: geometry.frame(in: .global)) { frame in
                    model.frame = frame
                    Island.passClicks()
                }
        })
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(model.label)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { onClick() }
    }

    /// The warm light Jelly casts into the glass, coloured by state.
    private var light: some View {
        let tone = Tone(model.tone)
        return RadialGradient(colors: [tone.inner, tone.edge, .clear], center: .center, startRadius: 0, endRadius: 29)
            .frame(width: 58, height: 58)
            .opacity(tone.strength)
            // Centred on Jelly.
            .offset(x: Size.ear + Size.side + Size.jellyBox / 2 - 29, y: Size.height / 2 - 29)
    }
}

/// The notch's body width, animated. SwiftUI runs this once a frame while the
/// width springs, which is where Jelly's box is placed: in the same frame as
/// the glass around it.
private struct BodyWidth: ViewModifier, Animatable {
    var width: CGFloat

    var animatableData: CGFloat {
        get { width }
        set { width = newValue }
    }

    func body(content: Content) -> some View {
        let _ = Island.placeJelly(bodyWidth: width)
        content.frame(width: width, height: Size.height, alignment: .leading)
    }
}

/// The notch: flush with the top edge, flaring into it at the top corners,
/// rounded underneath.
private struct Notch: Shape {
    var radius: CGFloat
    var ear: CGFloat

    func path(in rect: CGRect) -> Path {
        let left = rect.minX + ear
        let right = rect.maxX - ear
        let radius = max(0, min(radius, (right - left) / 2, rect.height - ear))
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.minY))
        path.addArc(tangent1End: CGPoint(x: left, y: rect.minY), tangent2End: CGPoint(x: left, y: rect.maxY), radius: ear)
        path.addArc(tangent1End: CGPoint(x: left, y: rect.maxY), tangent2End: CGPoint(x: right, y: rect.maxY), radius: radius)
        path.addArc(tangent1End: CGPoint(x: right, y: rect.maxY), tangent2End: CGPoint(x: right, y: rect.minY), radius: radius)
        path.addArc(tangent1End: CGPoint(x: right, y: rect.minY), tangent2End: CGPoint(x: rect.maxX, y: rect.minY), radius: ear)
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
        path.closeSubpath()
        return path
    }
}

private struct Tone {
    var inner = Color(red: 1, green: 181 / 255, blue: 156 / 255).opacity(0.8)
    var edge = Color(red: 1, green: 127 / 255, blue: 160 / 255).opacity(0.33)
    var strength = 1.0

    init(_ name: String) {
        switch name {
        case "off": strength = 0.3
        case "rest": strength = 0.55
        case "nod":
            inner = Color(red: 1, green: 214 / 255, blue: 140 / 255).opacity(0.85)
            edge = Color(red: 1, green: 170 / 255, blue: 120 / 255).opacity(0.35)
        case "warn":
            inner = Color(red: 1, green: 184 / 255, blue: 77 / 255).opacity(0.85)
            edge = Color(red: 1, green: 150 / 255, blue: 60 / 255).opacity(0.35)
        case "bad":
            inner = Color(red: 1, green: 105 / 255, blue: 105 / 255).opacity(0.85)
            edge = Color(red: 1, green: 70 / 255, blue: 90 / 255).opacity(0.35)
        default: break
        }
    }
}

private extension View {
    /// Liquid Glass from macOS 26, with the content in it as Apple asks: the
    /// clear kind, which frosts less and shows more of what is behind.
    /// Before that, a dark notch.
    @ViewBuilder func islandGlass<S: Shape>(_ shape: S) -> some View {
        if #available(macOS 26.0, *) {
            glassEffect(.clear, in: shape)
        } else {
            background(shape.fill(Color(white: 0.1, opacity: 0.86)))
                .environment(\.colorScheme, .dark)
        }
    }
}

/// Takes the click that brings the panel forward as a click, not just focus.
private final class IslandHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

// ------------------------------------------------------------------ the panel

enum Island {
    static let model = IslandModel()
    static weak var panel: NSWindow?
    static weak var jelly: NSView?
    static var monitors: [Any] = []

    /// Put Jelly's box at the left of the notch's body, which is centred.
    static func placeJelly(bodyWidth: CGFloat) {
        guard let jelly, let parent = jelly.superview else { return }
        let x = parent.bounds.midX - bodyWidth / 2 + Size.side
        if jelly.frame.minX != x { jelly.setFrameOrigin(NSPoint(x: x, y: jelly.frame.minY)) }
    }

    /// The panel is bigger than the island, so it lets clicks through except
    /// while the pointer is over the island. Mouse moves need no permission
    /// to watch, unlike keys.
    static func passClicks() {
        guard let panel, let content = panel.contentView else { return }
        let frame = model.frame
        let island = NSRect(
            x: panel.frame.minX + frame.minX,
            y: panel.frame.minY + content.bounds.height - frame.maxY,
            width: frame.width,
            height: frame.height
        )
        let over = island.contains(NSEvent.mouseLocation)
        if panel.ignoresMouseEvents == over { panel.ignoresMouseEvents = !over }
    }
}

@_cdecl("island_install")
public func islandInstall(
    _ panelPointer: UnsafeMutableRawPointer,
    _ webviewPointer: UnsafeMutableRawPointer,
    _ onClick: @escaping @convention(c) () -> Void,
    _ onMenu: @escaping @convention(c) () -> Void
) -> Bool {
    let panel = Unmanaged<NSWindow>.fromOpaque(panelPointer).takeUnretainedValue()
    let webview = Unmanaged<NSView>.fromOpaque(webviewPointer).takeUnretainedValue()
    guard let content = panel.contentView else { return false }

    let host = IslandHostingView(rootView: IslandView(model: Island.model, onClick: { onClick() }))
    host.frame = content.bounds
    host.autoresizingMask = [.width, .height]
    content.addSubview(host, positioned: .below, relativeTo: webview)

    // Jelly's page: a box at the top, placed sideways by placeJelly.
    let bounds = content.bounds
    webview.autoresizingMask = []
    webview.frame = NSRect(
        x: (bounds.width - Size.jellyBox) / 2,
        y: content.isFlipped ? 0 : bounds.height - Size.jellyBox,
        width: Size.jellyBox,
        height: Size.jellyBox
    )

    Island.jelly = webview
    Island.panel = panel
    panel.ignoresMouseEvents = true
    let monitors: [Any?] = [
        NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged]) { _ in Island.passClicks() },
        NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved]) { event in
            Island.passClicks()
            return event
        },
        // Right-click: the app's own menu.
        NSEvent.addLocalMonitorForEvents(matching: [.rightMouseDown]) { event in
            guard event.window === panel else { return event }
            onMenu()
            return nil
        },
    ]
    Island.monitors = monitors.compactMap { $0 }
    return true
}


@_cdecl("island_show")
public func islandShow(
    _ pill: Bool,
    _ tone: UnsafePointer<CChar>,
    _ words: UnsafePointer<CChar>,
    _ label: UnsafePointer<CChar>
) {
    let model = Island.model
    let said = String(cString: words)
    let width = pill
        ? min(Size.maxWidth, Size.side + Size.jellyBox + Size.gap + ceil((said as NSString).size(withAttributes: [.font: Size.font]).width) + Size.end)
        : Size.rest
    let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    withAnimation(reduceMotion ? nil : pill ? opening : closing) {
        model.pill = pill
        model.tone = String(cString: tone)
        model.width = width
        // Closing keeps the last words, which fade out as the notch closes.
        if pill { model.words = said }
    }
    model.label = String(cString: label)
}
