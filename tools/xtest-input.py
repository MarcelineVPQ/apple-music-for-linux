# Real X input for tools/rail-check.js, through XTest (ctypes, no Python packages needed).
# Only for a throwaway Xvfb display; never point it at a real desktop.
#   xtest-input.py :87 key ctrl+b [tab ...]   xtest-input.py :87 move X Y   xtest-input.py :87 click X Y
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
