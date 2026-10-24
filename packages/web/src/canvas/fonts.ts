/**
 * The typefaces a canvas can be set in, served by Kite itself.
 *
 * Imported by the canvas chunk only. Each face is a variable font split into
 * unicode ranges, so a browser downloads only the files for the fonts and
 * scripts a canvas actually shows, and nothing comes from another host.
 * The names they register are the ones FONT_STACKS in look.ts asks for.
 */
import '@fontsource-variable/inter';
import '@fontsource-variable/space-grotesk';
import '@fontsource-variable/source-serif-4';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource-variable/caveat';
