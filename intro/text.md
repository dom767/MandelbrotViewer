The mandelbrot fractal was first discovered in 19?? and originally imaged by BEnior Mandelbrot.

(firstimage)

The mathematics of the fractal are simple, a complex number is squared and has a constant added to it over and over again. If that constant leads to a stable orbit the pixel is coloured black. If that iterating formula escapes the circle of radius 2 then it is guaranteed to disappear off towards very large magnitudes, and the pixel is coloured based on how many iterations occured before the orbit began to disappear off to infinity.

(sampleorbit)

This gives us the basic version of the mandelbrot.

(MandelbrotOverall)

This mandelbrot viewer has a few extensions. First up it supports GPU rendering so it's much faster than a CPU mandelbrot renderer. You should be able to scroll around interactively on a typical laptop or phone.

(phonegrab)

Next we support deep zooms up to 384 bits of precision for each complex number. This enables zooms up to 1 x 10^90 which is as deep as you'll reasonably want to go before getting RSI from all the mouse wheel scrolling or pinch-zooming.

(deepzoom)

We also support more complex colouring algorithms like this rather beautiful stripes pattern, which can be applied to any depth of the mandelbrot and gives much better detail on the direction of deviations in the fractal.

(stripedmandelbrot)

I hope you enjoy taking a look around, and if you find any great spots please take a screengrab and upload to the server!