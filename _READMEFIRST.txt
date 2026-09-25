READ ME FIRST
=============

Before double-clicking "Install Roon Display.command" or
"Uninstall Roon Display.command" for the first time, macOS will likely
block them for one of two reasons:

  1. "cannot be opened because it is from an unidentified developer"
     (Gatekeeper -- applies to any script downloaded via a browser)
  2. "You don't have permission to open this file" / it opens in a text
     editor instead of Terminal (the executable bit was lost, which can
     happen when downloading or zipping files)

Both are one-time fixes. After doing this once, plain double-clicking
works normally from then on.

-------------------------------------------------------------------------
FIX BOTH ISSUES AT ONCE (recommended)
-------------------------------------------------------------------------

1. In Finder, right-click (not double-click) on this folder itself --
   the one containing this README, "Install Roon Display.command", etc.
2. Services -> New Terminal at Folder
   (If you don't see "New Terminal at Folder" in that menu, it needs
   enabling once: System Settings -> Keyboard -> Keyboard Shortcuts ->
   Services -> Files and Folders -> check "New Terminal at Folder".
   Then right-click the folder again.)
3. A Terminal window opens, already inside this exact folder -- paste
   this single command and press Enter:

   chmod +x "Install Roon Display.command" "Uninstall Roon Display.command" && xattr -d com.apple.quarantine "Install Roon Display.command" "Uninstall Roon Display.command" 2>/dev/null; echo done

You should see "done" printed. That's it -- both files are ready.

-------------------------------------------------------------------------
IF YOU'D RATHER DO IT WITHOUT TERMINAL
-------------------------------------------------------------------------

For the "unidentified developer" message only (not the permissions one):
right-click (not double-click) the .command file -> Open -> confirm in
the dialog that appears. Do this once per file.

If double-clicking instead opens a text editor, or you get a permissions
error, that's the executable-bit problem -- Terminal is the only reliable
fix for that part (see above).

-------------------------------------------------------------------------
AFTER THAT
-------------------------------------------------------------------------

- Installing / updating: double-click "Install Roon Display.command"
- Uninstalling: double-click "Uninstall Roon Display.command" (a copy of
  this one also gets placed inside /Applications/roon-local-services/
  during install, already unlocked, so you'll always be able to find and
  run it later even if this original folder is gone)

See deployment.md (inside roon-local-services/) for everything else.
