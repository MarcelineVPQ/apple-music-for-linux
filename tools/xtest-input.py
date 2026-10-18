# Real X input for tools/rail-check.js, through XTest (ctypes, no Python packages needed).
# Only for a throwaway Xvfb display; never point it at a real desktop.
#   xtest-input.py :87 key ctrl+b [tab ...]   xtest-input.py :87 move X Y   xtest-input.py :87 click X Y
#   xtest-input.py :87 wheel X Y N   (N notches: positive = up, negative = down)
#   xtest-input.py :87 drag X1 Y1 X2 Y2   (press at X1 Y1, move in steps, release at X2 Y2: a text selection)
import ctypes, sys, time

x11 = ctypes.cdll.LoadLibrary('libX11.so.6')
xt = ctypes.cdll.LoadLibrary('libXtst.so.6')
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XStringToKeysym.restype = ctypes.c_ulong
x11.XStringToKeysym.argtypes = [ctypes.c_char_p]
x11.XKeysymToKeycode.restype = ctypes.c_ubyte
x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x11.XFlush.argtypes = [ctypes.c_void_p]
x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
xt.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
xt.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
xt.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]

display = sys.argv[1]
if display in (':0', ':1') and '--force' not in sys.argv:
    sys.exit('refusing to send input to ' + display + ' (a real desktop?)')
d = x11.XOpenDisplay(display.encode())
if not d:
    sys.exit('no display ' + display)
NAMES = {'ctrl': 'Control_L', 'shift': 'Shift_L', 'alt': 'Alt_L', 'esc': 'Escape', 'tab': 'Tab', 'enter': 'Return',
         'space': 'space', 'down': 'Down', 'up': 'Up', 'home': 'Home', 'end': 'End'}


def keycode(name):
    return x11.XKeysymToKeycode(d, x11.XStringToKeysym(NAMES.get(name, name).encode()))


cmd = sys.argv[2]
if cmd == 'key':
    for combo in sys.argv[3:]:
        keys = [keycode(k) for k in combo.split('+')]
        for k in keys:
            xt.XTestFakeKeyEvent(d, k, 1, 0)
        for k in reversed(keys):
            xt.XTestFakeKeyEvent(d, k, 0, 0)
        x11.XFlush(d)
        time.sleep(0.08)
elif cmd == 'wheel':
    xt.XTestFakeMotionEvent(d, -1, int(sys.argv[3]), int(sys.argv[4]), 0)
    x11.XFlush(d)
    n = int(sys.argv[5])
    button = 4 if n > 0 else 5
    for _ in range(abs(n)):
        time.sleep(0.05)
        xt.XTestFakeButtonEvent(d, button, 1, 0)
        xt.XTestFakeButtonEvent(d, button, 0, 0)
        x11.XFlush(d)
elif cmd == 'drag':
    x1, y1, x2, y2 = (int(v) for v in sys.argv[3:7])
    xt.XTestFakeMotionEvent(d, -1, x1, y1, 0)
    x11.XFlush(d)
    time.sleep(0.05)
    xt.XTestFakeButtonEvent(d, 1, 1, 0)
    x11.XFlush(d)
    for i in range(1, 11):
        time.sleep(0.03)
        xt.XTestFakeMotionEvent(d, -1, x1 + (x2 - x1) * i // 10, y1 + (y2 - y1) * i // 10, 0)
        x11.XFlush(d)
    time.sleep(0.05)
    xt.XTestFakeButtonEvent(d, 1, 0, 0)
elif cmd in ('move', 'click'):
    xt.XTestFakeMotionEvent(d, -1, int(sys.argv[3]), int(sys.argv[4]), 0)
    x11.XFlush(d)
    if cmd == 'click':
        time.sleep(0.05)
        xt.XTestFakeButtonEvent(d, 1, 1, 0)
        xt.XTestFakeButtonEvent(d, 1, 0, 0)
x11.XFlush(d)
time.sleep(0.05)
x11.XCloseDisplay(d)
