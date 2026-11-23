"""Tests of config/bin/glyph-print: its parsers on what the CUPS tools print (LC_ALL=C), and its commands against fake
CUPS tools on PATH that answer from a table and write down how they were called.
    python3 -m unittest discover -s tests -v
"""
import importlib.machinery
import importlib.util
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "config" / "bin" / "glyph-print"


def load():
    loader = importlib.machinery.SourceFileLoader("glyph_print", str(SCRIPT))
    spec = importlib.util.spec_from_loader("glyph_print", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


gp = load()

LPSTAT = """printer EPSON-L220-Series disabled since Sat Nov 21 20:10:48 2026 -
\tUnplugged or turned off
printer Ticketera is idle.  enabled since Mon Nov 23 11:28:15 2026
printer Laser now printing Laser-12.  enabled since Mon Nov 23 11:30:00 2026
\tRendering completed
system default destination: EPSON-L220-Series
EPSON-L220-Series accepting requests since Sat Nov 21 20:10:48 2026
Ticketera accepting requests since Mon Nov 23 11:28:15 2026
Laser not accepting requests since Mon Nov 23 11:30:00 2026 -
device for EPSON-L220-Series: usb://EPSON/L220%20Series?serial=5647514B3239333170&interface=1
device for Ticketera: usb://Printer/POS-80?serial=776E176D3730
device for Laser: ipp://laser.local/ipp/print
"""

LPINFO_USB = """Device: uri = usb://Printer/POS-80?serial=776E176D3730
        class = direct
        info = Printer POS-80
        make-and-model = Printer POS-80
        device-id = MFG:Printer;MDL:POS-80;CMD:ESC/POS;CLS:PRINTER;
        location =
Device: uri = usb://Brother/HL-1110?serial=X1
        class = direct
        info = Brother HL-1110 series
        make-and-model = Brother HL-1110 series
        device-id = MFG:Brother;CMD:PJL,HBP;MDL:HL-1110 series;CLS:PRINTER;
        location =
"""

TICKET_OPTS = """PageSize/Media Size: X70MMY65MM X70MMY105MM X70MMY210MM X70MMY297MM *X70MMY3276MM Custom.WIDTHxHEIGHT
CutMedia/Cut Media: None EndOfPage *EndOfJob
Resolution/Resolution: *203x203dpi
OptionCash1/Cash drawer 1: *False True
OptionCutter/Cutter: False *True
CashDrawer1Setting/Cash Drawer 1: *None 1BeforePrinting 1AfterPrinting
"""

INKJET_OPTS = """PageSize/Media Size: *A4 Letter
ColorModel/Color: *RGB Gray
"""

MODELS = """raw Raw Queue
zjiang/zj58.ppd Zijiang ZJ-58
zjiang/zj80.ppd Zijiang ZJ-80
everywhere IPP Everywhere
"""

JOBS = """Ticketera-6             sajra             1024   Mon Nov 23 11:25:37 2026
Laser-12                sajra            20480   Mon Nov 23 11:30:02 2026
"""

FAKE = r'''#!/usr/bin/env python3
import json, os, sys
tool, args = os.path.basename(sys.argv[0]), sys.argv[1:]
with open(os.environ["FAKE_LOG"], "a") as f:
    f.write(json.dumps([tool] + args + (["<stdin>", sys.stdin.read()] if tool == "lp" and args[-1:] == ["-"] else [])) + "\n")
for want_tool, needle, out, rc in json.load(open(os.environ["FAKE_REPLIES"])):
    if want_tool == tool and needle in " ".join(args):
        sys.stdout.write(out)
        sys.exit(rc)
'''
TOOLS = ["lpstat", "lpinfo", "lpadmin", "lpoptions", "lp", "cancel", "cupsenable", "cupsdisable"]


class Parsers(unittest.TestCase):
    def test_lpstat_gives_each_printers_state_default_and_device(self):
        st = gp.parse_lpstat(LPSTAT)
        self.assertEqual(st["default"], "EPSON-L220-Series")
        self.assertEqual([p["name"] for p in st["printers"]], ["EPSON-L220-Series", "Ticketera", "Laser"])
        epson, ticket, laser = st["printers"]
        self.assertEqual((epson["state"], epson["note"], epson["accepting"]), ("paused", "Unplugged or turned off", True))
        self.assertEqual((ticket["state"], ticket["note"], ticket["uri"]), ("idle", "", "usb://Printer/POS-80?serial=776E176D3730"))
        self.assertEqual((laser["state"], laser["note"], laser["accepting"]), ("printing", "Rendering completed", False))
        self.assertEqual(gp.parse_lpstat("no system default destination\n"), {"default": None, "printers": []})

    def test_lpinfo_gives_the_devices_and_tells_a_ticket_printer(self):
        devs = gp.parse_devices(LPINFO_USB)
        self.assertEqual([d["uri"] for d in devs], ["usb://Printer/POS-80?serial=776E176D3730", "usb://Brother/HL-1110?serial=X1"])
        self.assertEqual(devs[0]["info"], "Printer POS-80")
        self.assertEqual([gp.is_ticket(d) for d in devs], [True, False])
        self.assertEqual(gp.parse_devices(""), [])

    def test_options_tell_the_ticket_settings(self):
        self.assertEqual(gp.ticket_state(gp.parse_options(TICKET_OPTS)), {"paper": "80", "cut": True, "drawer": False})
        narrow = TICKET_OPTS.replace("X70MM", "X48MM").replace("*EndOfJob", "EndOfJob").replace("None EndOfPage", "*None EndOfPage").replace("*None 1BeforePrinting 1AfterPrinting", "None 1BeforePrinting *1AfterPrinting")
        self.assertEqual(gp.ticket_state(gp.parse_options(narrow)), {"paper": "58", "cut": False, "drawer": True})
        self.assertIsNone(gp.ticket_state(gp.parse_options(INKJET_OPTS)), "an inkjet has no cutter: not a ticket printer")

    def test_jobs(self):
        self.assertEqual(gp.parse_jobs(JOBS), [
            {"id": "Ticketera-6", "printer": "Ticketera", "user": "sajra", "bytes": 1024, "when": "Mon Nov 23 11:25:37 2026"},
            {"id": "Laser-12", "printer": "Laser", "user": "sajra", "bytes": 20480, "when": "Mon Nov 23 11:30:02 2026"},
        ])

    def test_a_queue_name_cups_takes_and_nobody_has(self):
        self.assertEqual(gp.name_for("Printer POS-80", []), "POS-80")
        self.assertEqual(gp.name_for("Printer POS-80", ["POS-80", "POS-80-2"]), "POS-80-3")
        self.assertEqual(gp.name_for("Brother HL-1110 series", []), "Brother-HL-1110-series")
        self.assertEqual(gp.name_for("  #/ ", []), "printer")

    def test_the_driver_for_a_device(self):
        models = {"raw", "zjiang/zj58.ppd", "zjiang/zj80.ppd", "everywhere"}
        pos80, brother = gp.parse_devices(LPINFO_USB)
        self.assertEqual(gp.ticket_driver(pos80, models), "zjiang/zj80.ppd")
        self.assertEqual(gp.ticket_driver(dict(pos80, id="MFG:Xprinter;MDL:XP-58IIH;CMD:ESC/POS;"), models), "zjiang/zj58.ppd")
        self.assertIsNone(gp.ticket_driver(pos80, {"raw", "everywhere"}), "the thermal driver isn't installed")
        self.assertIsNone(gp.ticket_driver(brother, models), "not a ticket printer")


class Commands(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="glyph-print-test-"))
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        self.bin = self.dir / "bin"
        self.bin.mkdir()
        for tool in TOOLS:
            f = self.bin / tool
            f.write_text(FAKE)
            f.chmod(f.stat().st_mode | stat.S_IXUSR)
        self.log = self.dir / "calls.jsonl"
        self.replies = self.dir / "replies.json"
        # the desk as it is: an unplugged inkjet (the default), the ticket printer, and a second printer on USB not added
        self.reply = [
            ["lpstat", "-r", "scheduler is running\n", 0],
            ["lpstat", "-o", JOBS.splitlines(True)[0], 0],
            ["lpstat", "-p", LPSTAT.replace("printer Laser now printing Laser-12.  enabled since Mon Nov 23 11:30:00 2026\n\tRendering completed\n", "").replace("Laser not accepting requests since Mon Nov 23 11:30:00 2026 -\n", "").replace("device for Laser: ipp://laser.local/ipp/print\n", ""), 0],
            ["lpinfo", "--make-and-model", "everywhere IPP Everywhere\n", 0],
            ["lpinfo", "-m", MODELS, 0],
            ["lpinfo", "-v", LPINFO_USB, 0],
            ["lpoptions", "-p Ticketera", TICKET_OPTS, 0],
            ["lpoptions", "-p EPSON-L220-Series", INKJET_OPTS, 0],
        ]

    def run_gp(self, *args):
        self.replies.write_text(json.dumps(self.reply))
        self.log.write_text("")
        env = dict(os.environ, PATH=f"{self.bin}:{os.environ['PATH']}", FAKE_LOG=str(self.log), FAKE_REPLIES=str(self.replies))
        p = subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, env=env)
        return p.returncode, json.loads(p.stdout), [json.loads(line) for line in self.log.read_text().splitlines()]

    def calls(self, log, tool):
        return [c[1:] for c in log if c[0] == tool]

    def test_list_is_the_whole_picture(self):
        rc, st, _ = self.run_gp("list")
        self.assertEqual((rc, st["ok"], st["default"]), (0, True, "EPSON-L220-Series"))
        epson, ticket = st["printers"]
        self.assertEqual((epson["name"], epson["state"], epson["connected"], epson["ticket"], epson["jobs"]), ("EPSON-L220-Series", "paused", False, None, 0))
        self.assertEqual((ticket["name"], ticket["state"], ticket["connected"], ticket["jobs"]), ("Ticketera", "idle", True, 1))
        self.assertEqual(ticket["ticket"], {"paper": "80", "cut": True, "drawer": False})
        # only what isn't a queue yet is offered; the Brother has no driver here, the list says so
        self.assertEqual(st["found"], [{"uri": "usb://Brother/HL-1110?serial=X1", "name": "Brother HL-1110 series", "ticket": False}])
        self.assertEqual([j["id"] for j in st["jobs"]], ["Ticketera-6"])

    def test_list_without_cups_says_so(self):
        self.reply[0] = ["lpstat", "-r", "scheduler is not running\n", 0]
        rc, st, log = self.run_gp("list")
        self.assertEqual((rc, st["ok"]), (1, False))
        self.assertIn("cups", st["error"])
        self.assertEqual(self.calls(log, "lpadmin"), [])

    def test_add_a_ticket_printer_with_the_thermal_driver_and_ticket_defaults(self):
        self.reply[2] = ["lpstat", "-p", "no system default destination\n", 0]  # nothing added yet
        rc, out, log = self.run_gp("add", "usb://Printer/POS-80?serial=776E176D3730")
        self.assertEqual((rc, out["ok"], out["name"]), (0, True, "POS-80"))
        self.assertEqual(self.calls(log, "lpadmin"), [
            ["-p", "POS-80", "-E", "-v", "usb://Printer/POS-80?serial=776E176D3730", "-m", "zjiang/zj80.ppd", "-D", "Printer POS-80",
             "-o", "PageSize=X70MMY3276MM", "-o", "BlankSpace=False", "-o", "CutMedia=EndOfJob", "-o", "OptionCutter=True"],
            ["-d", "POS-80"],  # the first printer becomes the default
        ])

    def test_add_keeps_the_default_there_is(self):
        rc, out, log = self.run_gp("add", "usb://Brother/HL-1110?serial=X1")
        self.assertEqual((rc, out["ok"]), (1, False), "no driver for it here: only everywhere answers its make and model")
        self.assertIn("driver", out["error"])
        self.assertEqual(self.calls(log, "lpadmin"), [])
        self.reply.insert(0, ["lpinfo", "--make-and-model", "brother/hl1110.ppd Brother HL-1110\neverywhere IPP Everywhere\n", 0])
        rc, out, log = self.run_gp("add", "usb://Brother/HL-1110?serial=X1")
        self.assertEqual((rc, out["name"]), (0, "Brother-HL-1110-series"))
        self.assertEqual(self.calls(log, "lpadmin"), [["-p", "Brother-HL-1110-series", "-E", "-v", "usb://Brother/HL-1110?serial=X1", "-m", "brother/hl1110.ppd", "-D", "Brother HL-1110 series"]])

    def test_add_refuses_what_it_cannot_add(self):
        for uri, why in [("usb://Nobody/Here?serial=0", "connected"), ("-x", "address"), ("Ticketera", "address")]:
            rc, out, log = self.run_gp("add", uri)
            self.assertEqual((rc, out["ok"]), (1, False), uri)
            self.assertIn(why, out["error"])
            self.assertEqual(self.calls(log, "lpadmin"), [], uri)
        # a ticket printer without the thermal driver: says which package is missing
        self.reply[2] = ["lpstat", "-p", "no system default destination\n", 0]
        self.reply[4] = ["lpinfo", "-m", "raw Raw Queue\neverywhere IPP Everywhere\n", 0]
        rc, out, log = self.run_gp("add", "usb://Printer/POS-80?serial=776E176D3730")
        self.assertEqual(rc, 1)
        self.assertIn("zj-58", out["error"])
        self.assertEqual(self.calls(log, "lpadmin"), [])

    def test_add_a_network_printer_is_driverless(self):
        rc, out, log = self.run_gp("add", "ipp://laser.local/ipp/print", "Laser")
        self.assertEqual((rc, out["name"]), (0, "Laser"))
        self.assertEqual(self.calls(log, "lpadmin"), [["-p", "Laser", "-E", "-v", "ipp://laser.local/ipp/print", "-m", "everywhere", "-D", "Laser"]])

    def test_actions_on_a_printer_there_is(self):
        for args, tool, want in [
            (["remove", "Ticketera"], "lpadmin", [["-x", "Ticketera"]]),
            (["default", "Ticketera"], "lpadmin", [["-d", "Ticketera"]]),
            (["pause", "Ticketera"], "cupsdisable", [["Ticketera"]]),
            (["resume", "EPSON-L220-Series"], "cupsenable", [["EPSON-L220-Series"]]),
            (["cancel", "Ticketera"], "cancel", [["-a", "Ticketera"]]),
            (["cancel", "Ticketera-6"], "cancel", [["Ticketera-6"]]),
        ]:
            rc, out, log = self.run_gp(*args)
            self.assertEqual((rc, out["ok"]), (0, True), args)
            self.assertEqual(self.calls(log, tool), want, args)

    def test_actions_on_a_printer_there_isnt(self):
        for args in [["remove", "Nope"], ["default", "-x"], ["pause", "Nope"], ["resume", "Nope"], ["test", "Nope"], ["cancel", "Nope"], ["cancel", "Nope-3"], ["set", "Nope", "cut=on"]]:
            rc, out, log = self.run_gp(*args)
            self.assertEqual((rc, out["ok"]), (1, False), args)
            self.assertEqual([c for c in log if c[0] in ("lpadmin", "cupsenable", "cupsdisable", "cancel", "lp")], [], args)

    def test_set_the_ticket_options(self):
        for arg, want in [
            ("cut=off", ["-p", "Ticketera", "-o", "CutMedia=None", "-o", "OptionCutter=False"]),
            ("cut=on", ["-p", "Ticketera", "-o", "CutMedia=EndOfJob", "-o", "OptionCutter=True"]),
            ("drawer=on", ["-p", "Ticketera", "-o", "CashDrawer1Setting=1AfterPrinting", "-o", "OptionCash1=True"]),
            ("drawer=off", ["-p", "Ticketera", "-o", "CashDrawer1Setting=None", "-o", "OptionCash1=False"]),
            # another width is another driver file: the roll's page and what was set (cut on, drawer off) are put back
            ("paper=58", ["-p", "Ticketera", "-m", "zjiang/zj58.ppd", "-o", "PageSize=X48MMY3276MM", "-o", "BlankSpace=False",
                          "-o", "CutMedia=EndOfJob", "-o", "OptionCutter=True", "-o", "CashDrawer1Setting=None", "-o", "OptionCash1=False"]),
        ]:
            rc, out, log = self.run_gp("set", "Ticketera", arg)
            self.assertEqual((rc, out["ok"]), (0, True), arg)
            self.assertEqual(self.calls(log, "lpadmin"), [want], arg)
        for name, arg in [("Ticketera", "cut=maybe"), ("Ticketera", "paper=70"), ("Ticketera", "color=red"), ("EPSON-L220-Series", "cut=on")]:
            rc, out, log = self.run_gp("set", name, arg)
            self.assertEqual((rc, out["ok"]), (1, False), arg)
            self.assertEqual(self.calls(log, "lpadmin"), [], arg)

    def test_the_test_print(self):
        rc, out, log = self.run_gp("test", "Ticketera")
        self.assertEqual(rc, 0)
        (call,) = self.calls(log, "lp")
        self.assertEqual(call[:2], ["-d", "Ticketera"])
        self.assertEqual(call[-3:-1], ["-", "<stdin>"], "a ticket printer gets a ticket, as text")
        self.assertIn("Ticketera", call[-1])
        rc, out, log = self.run_gp("test", "EPSON-L220-Series")
        self.assertEqual(rc, 0)
        (call,) = self.calls(log, "lp")
        self.assertEqual(call[:2], ["-d", "EPSON-L220-Series"])
        self.assertTrue(call[-1].endswith(".pdf"), "any other printer gets CUPS' test page")

    def test_a_tool_that_fails_is_an_error_with_what_it_said(self):
        self.reply.insert(0, ["cupsdisable", "Ticketera", "", 1])
        rc, out, _ = self.run_gp("pause", "Ticketera")
        self.assertEqual((rc, out["ok"]), (1, False))
        rc, out, _ = self.run_gp("nonsense")
        self.assertEqual((rc, out["ok"]), (1, False))


if __name__ == "__main__":
    unittest.main()
