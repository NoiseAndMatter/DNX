/**
 * A blank Digitone II project, captured from an initialised device.
 *
 * **Generated — do not edit by hand.** Regenerate with:
 *
 *     npm run extract-blank-project -- --project EMPTY.dn2prj
 *
 * The whole `.dn2prj` file, base64. 7,805 bytes, which is small because a
 * project file is a ZIP around an LZ4 payload and an empty project compresses to almost nothing.
 *
 * ## Why the file rather than the image
 *
 * The image is 12,889,604 bytes and would have to be re-wrapped to be written out. The file carries
 * its own `manifest.json`, which is exactly what `buildProjectFile` needs — so this one artefact
 * serves as **the blank destination, the donor for a device read, and the manifest for an export**.
 *
 * ## Why it is safe to have here
 *
 * It contains no music: the generator refuses to emit a project with a single occupied pattern or a
 * single named pool slot. The project identity at `0x18` travels with it and is inert, because
 * everything DNX authors re-mints its own.
 */

/** The blank project file, base64, split for readability. */
const CHUNKS: readonly string[] = [
  "UEsDBAoAAAgIAI6k+VwMwq5hXAAAAIQAAAANAAAAbWFuaWZlc3QuanNvbqvm5VJQUHLLL8pNLAlLLSrOzM9TslJQMtQzUNIB",
  "SwUU5aeUJpeEVBakAiWiY6GiiZU5+YkpIKWuvgEhkVDFbpk5qVCVII1ZqcklcJmi3PLEolQUOwwNXJV4uWoBUEsDBAoAAAgI",
  "AI6k+VyVLituTx0AAN5DAQAFAAAARU1QVFntXQ14FNW5/mb2N+Tn7CSbECWSJfymUJLN5hewWQQCAYEEEATkT4Igyk+IP6BA",
  "FqmIqEAQ0YptoWLFXvVixYrah8c+1/b6WC9X23r1iq32ebRiLwi2FK1/e8+ZPTs7MzvZnd2dnZkt+/ZJZpKZMcu853vP953z",
  "ff2e5H5vYcEGqLq6rhoAGPxlwV8IXnnayuThsz+esx0/++IJ8vsJU9tmzYXpkyeMm4Vv9N80qnm+ExALwTcXkWdcVvikPMhA",
  "MBhcc94xpqPAEQC/31+Q5wcXsB22IID/NjvXzQJ61BrUAsdRVSs+rCGfIUEsa+MP+GPvQEzCT2uNFcKnOUnfoICR5fhdn0Ys",
  "o/hg8ni3AL80tpFwg0lnAYI8/ReuOeMcyAh8onz2DP921xwREXrYdhPl81GrGj4XCP+8vfzLPoVu9sR8IIypyDcsGPw4CX5V",
  "gRM+1x75a08ndsSm9NU2oPgf/Lba0ci+yvfFxwMyjhnK8bE0cKwGW9rwJ+GxH/1zwmZ03/iQ8Z5B901woYHMmXQRrQ5VwnDo",
  "0UgTlqduvKeF0fAn8h97CN0yWum2ShnVLKV6r0FUExxH1ZNUqHN7pkixEq5InWFFyOXZQvlcmyKfrYIJ/gD9M/9d9Ele2AQ/",
  "yY/xcWLh/9B/NmpjuReM0WMl/CjC61GJHlciuyXew4ngTRnRVkr06ykSrQarhPf9AHnfJ9DCkb3cORv5Sk9owrEqjNJciZVw",
  "e2K2+44wDv5IHlyLpg2N90gYy2Qk2yjJh1WR7GE7HrO5k+S4NyiI8+UmFeKkxWB2YgSrwdfCIHgPv6MX0L4p+JdfyOi1U3q/",
  "r4re1Gy4N6icfOVYIrz1e5J961piufBx3lUYkj7t+eUhn3wdlM/FGvM5V6q/weB49Lt+vd4tx3nkG0EeSZBhNTiii/4qYVfv",
  "lL4imN7b5KZJaEhR9E3qcVBGspOS/EuNSVaDTbIAObgQ/dVPfvM88jnxYUE6SFaBl1LXYCWsTM1uT0UmYvy2etDqht7urJNx",
  "nEM5fsgAjsNQIcxTM0mElTAxNYJ7hVyY+1A+b0qBzwl4NIVCoofRlzkNqMUZjohacuJ8nJi4H628PPWw6G8m9cneJwOzQiea",
  "cynNbRX4fR6TUP0Oc4x/x4fUUK0G10ukeAR6qTLGzd8gX9nwlDlWhf9NjxQrYbN6Wv8gkeLrUcvAeE+I0SnjOY/y/GQK5pwq",
  "ZPLcZFYpTsUxm6+eYDX4QrpEeQTtnBi+ZJMxnE8Z3m4ehtVggUlVuNclynptGRYgV+YCymeHhnxeJXWGD6KqBDdAHkG+6uCB",
  "RPhVhTb9FFgJe5QpfVmyOjkW9UfKj6vHUzKOEeX4ZQ05VoMN8uj4BTRxjHB1EfLlkV9pzbIKzNdEhJWwJnmz/VAqwtvRdb5Y",
  "t4+VkeyiJD+iM8lixBHm1kwTYSVMTp7hmJALM0f5XJ8kn2Mjxhd62X21YHk08o3Hh5IUrPY3ZnXIwrHxUJ0YLqQMz0qSYTVY",
  "RkSFD44fRl9VPoleGhaOjeOERf8oSz30jYuitOmwEraq4/UNqQ4vRt8rj/1ANDbJmC6iTB9JI9PxINLmOpPqcMpe2UJ1DKvB",
  "eUlc/ATaNk58lZMR7KYE32sOgtVgrtllWAmjtSNYArk0F1M+V2jEZyRDZi952V+jewuj7omP8chX+7VaflXhrK4CrIQHoxn9",
  "pXSbqBGV5Pb+vHq8IOO4hHL8ikYcq8HNMqesLzok2/pwIJ8rNf8qKXypnQgrYV1ydvuBRIS3oIVV8Z6YKiO5LyX5gI4kyxFD",
  "mCeYVYSfT1AOpidHcFzIhbmU8rlRzueHwkd/JvQm1+lDrQ9Tuy5Za73OpI6YJCD+jk7UXkKpvTpNprqkjcRB5Gs/mjsgB5UO",
  "CodCpYPjPfsYemhAmuMhlF4FVsK2+My+LlmcnIvq1We3iHC3jOpLKdVH00S1GtwZmYrL8PsmCex5Pkgvx6owSFOfbGl8jtXg",
  "nDQoPoA2N8tvuUxGcj9K8m4DSU4gJroqE7RYCd/ThuEoyPW5jPJ5owZ8RvJjyA7RvFRS132Nc9XQqw679BdhJTwspfSYRIS9",
  "qMAR+3H1+LWM48sox69qwLEadMp2iNYhRmHT42nkcyfvZCWFhzUVYSXcmrjZvicV4fVo9vB4jxDMlZHcn5J8SCeSldCLMI81",
  "qQjfn4wazEicYVVgJHLwezG15ZTawBnnBZNRqwaRml6ThcPyNcmqNFErn3M9lM/01vTS3fmPTVfUmy7tVcI9sSmN1PTyi5Jt",
  "Ghb1DqAkZ4t6FREp6tXMJ7sudfONVPWSpckfqCzqraBUZ1RRr8m1WAnjUidYEXJ9Hkj5vEiKevXUYyX8OELrUakeD0tzUe8g",
  "SrS+Rb0kOP5vE9b0aibESrgtMdt9RyLEnSnU9A6mHKur6U2N494Qs6jXZEKcrBrMSYxgNYgU9fKV3ceUq3qHUIIzuqrXXIGx",
  "4upkjfYE85DPvkMpn+mr6g0Vc04wXVFvWgVYCTt7p/QVyXJEq8ZFvcMox8YW9dIIObjAbFW9yWqwEm5IzWwjRb386uTuBKp6",
  "KynJGVPVmwEirISW1BjuFXJh/g7l82Ko6jWZU/YnPDIH6kTzcEqzvlW9vBYPj5e/bkBZr5ZarIRu9bT+QarFK1Is6x1BiTZl",
  "Wa+5tDglz2yeeobV4AtJaPxMjKre71KCM7aq12Qq3NsaZYO2BAuQK/NIymd6qnpD3vAB85X1pluBlXC/MqWRql5+fdKfhrLe",
  "KkqycWW9ofD4RdNV9aYkwkpYnbzdfigR4bsTrOqtphxnRFVvhoiwEqYkT3BMyIXZS/lMvap3H33ZJVrQrGlZr7kcMiE4HqIT",
  "xTWU4mxZbxqEWAl3qCP2DYkQL9GgrNdHmTZdWa/JhDhVt2yROoLV4Lw0MD4cp663ljKckXW9JtVhJYzSjmEJ5NpcR/nUvq73",
  "fvyyvzFfWa8uAqyEfdGMRup6yUZRU5rKeuspxcaU9VKvrMR8db2pirASupIz2w+kIhxIoq63gbJs+rpec4nwsUTlYFpyDMeF",
  "XJgbKZ8x6nqP8G+ySx9mNSrrNZkjJo6Ih+vEbBNl9qIv602HACvhrvjERqp6+cXJqzUq6x1FqTZHWe/efHNW9Wrikl0bn2Q1",
  "OCeJiQ+qqOodTTnOuKpeE0uxEpq1ITgKcnkeQ/nUtqqX3yGam0ryeprKevUSYSXsl1J6TCrC1Wks672ckqx/WS+/Q9Rlvqpe",
  "TURYCbckbrfvSUR4Q5JVvd+jHJu6qtdkIrwnCTWYmTjBqsBI5eB3Ym6bKbcZX9ZrrmjYsFa9fspnest6s616gwa26h1LOc5W",
  "9SriX6lV7xWU6oyq6jW5FCvhitQZVoRcnsdRPi+Sql5d9VgJiq1630Hpb9U7nhLdW1XveYeIafJUSqabbdabiPW+I9XiVJr1",
  "TqA0m7aw11xanLQeGNWtt4Xym9F1vSYLjY3s1juR8pm+ut5st14K47r1TqIkG1vYm+3WGx/Jd+ttpRxnTF1vBoiwEvTq1juZ",
  "8nkx1PWayyfTtVvvFEqzvnW92W698W7UulvvlZRnU5b1mkyKU3HMjOvWO5UynLF1veZSYcO79U6jfKanrjfbrVcEw7r1Tqcc",
  "G1fWm+3WGx8pduttoyRnRF1vhoiwEvTq1ttO+Uy9rjfbrTcWjOvWO4MynC3r1V6HlWBct96ZlGnTlfWaS4dT9soM69Y7ixKc",
  "kVW9JpVhJejVrfcqyqf2Vb3Zbr1SGNetdzbl2Jiy3my3XhVIvVvvHEqy6at6TSbCZu3WezXlM9utV3sY3K13LqX2oi/rTYsC",
  "K8Gwbr3zKNXmKOvNduuNjyS69c6nJGdcXa+JtVgJenXrvYbyqW1db7ZbrwIM69a7gHKsf1lvtltvfGjUrXchJdnUdb3mEuFM",
  "6da7iFKb8WW9JguHjerWu5jymd6y3my33qCR3XqXUJKzdb2K+Ffq1nstpTqj6npNrsVK0Ktb71LK50VS16unHivBuG69HZTo",
  "bLdeTYVYCYZ1611GOTZtUa/JhDhZNTCsW+91lOCMruo1V2BsaLfe5ZTP9FX1Zrv1UhjWrXcF5djYot5st974SKFb7/WU5Iyp",
  "6s0AEVaCXt16V1I+L4aqXpM5ZXp2672B0qxvVW+2W2+8GzXv1nsjJdqUZb3m0uKUPDPDuvWuogRnbFWvyVTY6G69qymf6anq",
  "zXbrFcG4br1rKMnGlfVmu/XGR2rdetdSjjOiqjdDRFgJenXr7aR8pl7Vm+3WGwsGdutdRynOlvWmQYiVcIc6YrXv1ttFmTZd",
  "Wa/JhDhVt8y4br03UYYzsq7XpDqsBL269d5M+dS+rjfbrVcKw7r13kIpNqasN9utVwU06NZ7K2XZ9HW95hLhY4nKgV7detdT",
  "PrPderWHsd16N1BmL/qy3nQIsBKM69Z7G6XaHGW92W698ZF4t97bKccZV9VrYilWgl7dejdSPrWt6s1261WAcd16N1GS9S/r",
  "zXbrjQ9tuvVuphybuqrXZCJsym69lvXkL0i69XZTbgNnbBeYt46fffEEuW9K6yyPtwRYFso7WMizjAEXOxLmts2YMHPCOODW",
  "sgCrmE4LkLHgxz+MILcWMg7IZ8E+DJhGGLi+uQLYavB6oNsFVie4mLcZix3YUYBHF+OFAQCjgC0AsANYgXXDEQAndIMHFkNp",
  "PjBPArd6FnibYagLnCyMteKP+XfibtVyHZNgYj4UoAcZKwvTXzxxLm85A+4aD6DlTPBKl28Jgz8NvM6iE2ywpbB2KYP/nbCM",
  "IVdbXHWhq/THwnrp1Qbp1Ubp1SbJ1QpvdQd/Ns0+uYD+uYl2RwG9nsipD47lcP6fFVuPFXs7oO/TxZzneDEHvyjudEE5+KGm",
  "kMQhbD2wnxbjl9HpgVL8ovyPlHBtV4KzP3kt/dgXi51PFE+e2jq+tb0v2FjkYIeTT/stucqd69sCE2EStMJkmAJXwlSYBtOh",
  "DdphBsyEWXAVZnL22Cu9NnDV4C8f/qrFX3X4qx5/NeCvRvzVZAOPt7oGXAo3uuv3Qd5zJUweY3/SiTbl1uC/jvKYQ/Z2Jz6c",
  "tV9w8If9/ME2zUre7CgbGmM75Tjtxr/71NETOtSHDieL+PsD/MG5oQ+02NEk+6lSLz7tw+BffuKMdfa2tbiSfcPl2rIAIRs0",
  "wBzyHobDHBe6AvgEPsZytBAOVuIhi76tzEXwnXh2lAxYQYF/aIXN+d/MZAqX4z+ei02Kyd+EsLYaDE+bHw8wYvSjycHybfeA",
  "9c1/767G5mbDowWbrxM4phRYO5RjU7eqMN0yBdOdFwib7hJiusFgLrnEG++JAJT4BoVUxcIwVYzFwtg9wDYwWCnY4Qwe61hQ",
  "iJlYXLXlEvusk9pnvdR6G6RXG6VXmyRX8ai+lmGEnydyXvHlia4aydV49iwx7b/aOf84t7XdTUz73iLOM8fNwXR3lGl/vwi/",
  "kbXUtL9xD4C2T/eGbXum23mFezaxbY8jB1t2ja6WbfsbmzetmBo2sckYFj3WgcY5iPBgwz4Uy7CJoYbMX61Fi2y7CE/2vHF/",
  "N7d34y639GMY9O3j2LYPxzODZGEP2zfDoeXdnY4dC2DNfNQ5fzj+Keh0fLQgPMAc/oXCqft64XRN5PS1yOnglcJACkROT0ZO",
  "629QP/4OrdRbZh5r450K8lK82EmYvYoMjMWrIj4CDAFW2U2gUgONhFBGhdjI/AR0ItBp/+ca5os16Ms1QV+AejTsaUbvlyDH",
  "s/ilhIR2GB4bP3U15G3m5aibjBRVrsYjW4NTB3ipMFF/QyZMnE8qW7XSqxK9xIPkXmGQHGU5f8FO63MFRKQKd3Keip0cXLoz",
  "SqRm7BT5H7BL5H94gsFqcP70XkGlOvvoq1LE/5hKJpTM0qnDHNh+kh/xtJ37fuzY4IRRFjTGMhx1/ASryB+cgjJU5QinOyKn",
  "H0VO/X0iMlMckZnI6WuR08ElalUk7qkPDpZo50J1C17TA24iJAsXoTcXAIJZ8R5MNyaFlc1yfBE5EI/I2i/AdQ8C6F2jhkDP",
  "avwUA2GVupq4RCxHBsMIrsMv8YmwglkHe6sH8w5RJ/lrWEJfIrGaDUdvlzBEF8X6OZjoJ+f5LmN3AuQzVkE8oRp4F1uinpir",
  "Ay7vL0CsCjVSzfBJNaNWerVOelUSP/lgKsP51/WxXpJDZOSlHM6zrQ8Hm/tEycj0HJGMfJMjDmPu6ONsvscwV4cPYjblJuHr",
  "FDYcJ1FwyPBPOXr2EA1xNVlJkAolLCplT4kUhf+FWhlJTFBwVMNeJhIU5q3LVvCR+6y/FYZlZcll+shKIEWF0VZWCLYK0sLn",
  "keSzfW/GE3CZCbSlkP9k2EWw3DIWH/yWQGiFZX1zHiiFY+p9JFlAJlYfrDYVxb6bRdEXcznDniQjORSACVJD6LAW1zYyYZbK",
  "6/D3WeX1+LsfZmDDv9xunWInhr/Nxnna7Ry02qMMf7NNFOR8bsdBjtSB6KQO2xE7lYC70FtWfSUARzvUjSitOQrwvg392TZc",
  "tJZRyiqrwUgrqraecjWELD4kA+5GJ6+PoZ/CahD6aZC3OofBynGW9ytSFoTelzkOc3wkJOjBucIoPRhxSabowSGN9YDgLkET",
  "ejisCVgP1hmvB++1wVr8P2yVW95cC9QPCLkcDBfAczDH2MlaqrDeOlApkEp2vRXrwrri+j1iXVhGdQHKpT4I5uUsDMb272St",
  "JSyx/3aG85RhgXGzUfbfyogm/i9ZefwgxGt5sJi3f28fIBZj0HIm1QF3TX8QWbFPbMX2C3cSDeDqbIxFmOipItD7E1SESXaN",
  "FOF6V4yYI1gsdhEUJOFz93nMLGSGKmjtJYRxT3hOhh8wM2fC3JnscyRe3wGPmyAaeb6NH+N4aL7Fn8UZ6Wu91eR2RZs40I3H",
  "5MtktIcN0EUNsIY3QHEssjWA77ViiyglYhJyEZzDoL9nIBlo7GeFcU3zfWzQZDqdUep7LDz2y2vzmC/K6/A3ajwVFjTIkrDx",
  "5DHnOK+dXztJxX48RCSFOXWmogXdyYkt6EPu1pAFeYTgnSkrxLL8EBbbwiLPE3tEq1tlhURBLWOBEWky+nzPHr0sTr1t9WZx",
  "R4rTt6q6q40fOXi8Yf+qe7X9wnx07Fbsbc0nSmv38wfH6RVo+jVeQvT7XWRKQGO2bnT0rED8Ak7ocHI5/0AgdBgcOrx2HaIx",
  "2MGl6NGlvGc3y3FIaXHnbUtwU2HwqU3oq00NzBQwYgUxkkZ1yI49k1O3b3Te1cVs60Lbu94WJsv9hi9uBn8T/pws34u4AJUG",
  "NpY2PoOtMIBPT5U3YcMe6q3OZ+gMWeX1EnuvId985Jtg/s4N20M7fRFDbN7iwYLRRO2Q3zQSDPHGHVLn9vCOKDvsomHUfmx/",
  "TmjSaksrshs9nSzfDMR/4zybggFzDQ2OyNKKLkZ8Jj+BXedw1NZRIo7aQtvOzLGDdkcOeuUnZ2Mtm9j9jpDputF0J2+6LQ7e",
  "dNMyd2OUCdbzcBHUdtn7zEalsw8RXRg051PDbaYn/Oksk0h87+3G7wI4/6UB+yWAjeaxkpr/wAOTOODnoRmP4Q+BTJr/JbOX",
  "8vo85i+iOeszm2jOktjKkpBe5DvyxXkdTRCgBuPNI+49utFRxRxyVKxvng6Ww86ogOLnTnUBRakzMZMhI3IytpfQcQc9fkSP",
  "/j78kdpI6LyRX4oMnTdFzh2D95LjFDzQEzk2QHluAtYQjmG+is7BmEQcp4K+OGLx6h6xRBIwtpfHWrtE4xxVKjY/ItkXWJBP",
  "kzkS/3jGqXA4aQlWFgbfcKGvKslcyQ7k8L+6kvhMfqgkw89CFibzvWlKt/gqHC3Dfdhl+Nh453xVG0uNu31bKJKtw/Mi8aOx",
  "aX9cUp/LMDJ3M8YstyucmCWa6VzsGJnl0unOZXkQeOsdALpMd1xNrWg7oYWT7B/gae+ueNPegzbx442Sx6lhh38c4K2WbWGq",
  "nu16mwOfTyTzKtYcyF7dz9liyFIFyc8Q7P7qfn/KL2WNSroKq4DG5k1R0UbeVD1+Yz1FZBvu6FLjDT14jeD6frU1bKeOQI54",
  "jq2TWSqRgXY+nF6EJ3wcNJeR9SUXYyMjRpIdMSi17IjYhizedoQHtxBjLqkZJBhbuW85WeCv5b9HFvtnlTfw3xv5703k+2Bv",
  "9QoG6nNRY26wpcSr3vx6M8pfJmKU4alYIR3SHFNxItuI6THL9MXqwdpwAiHTj2Sy5DqqFoBzHuozbzg6EQg6SUaUoP9pyoZK",
  "ZGSdWKev3/+oEII828bvu829Qcn8nhGtvd1kyEqDFH8VEh1ui+R52/+tu4TJhRzRpkN/jTcdOkvqe1RuOgQtJQ1N4d3Ilmg5",
  "8llRnTXYUuX18ldq+O9RkkbGxgonWunEY+MFkgTlspa5iOrMQZynwsXBpa7o7AUkToLixKpzerfz5G5jsxc+7tFYdoiMpDMD",
  "CscFtkHiDKjfPirKgPqmQp+tSfUi0pu0aLcJsakttOkAsNs2ZQ2W1R8a7+c8LaxW3GtjpHsFbsG9aRTcm2ckO5ZSB8ce07sR",
  "1MPyYiCyOH4i8Jir6SWISorEZ9M47XIiXfXiqz6Yxsz0E8H6Khf7a1gV7s77zOrh9QuA5HSJpQGGAYzLwwInUoff5kWlSDbn",
  "G5oimTelICl92GOkPrxRLtaHKo9IH6o8F58+EGwJz9DwAcf4yRaIBda2EuIOdounXC+ecnd2VYcm3MkA67raI4mIfEAwfDHx",
  "SNgjXXxgP/9agBHXoh8vNn5TIbhe0JwORDYVlndXFHtnS3YjK8hupK0cm18gIPEQIqmRewMkNfKmQLzUyBOBA64aaWpkatLB",
  "+ddtt/7cQbyJWU7Os207B5u3R3kTpxwivdjnlORCbnd2bjfWm9h0dxJqIc2FLGwMbcjSn5rEPzlO9oQlJJX92vgKsr+fJCVy",
  "f1S+w5f99NERMyY73CmkOfTY+t2KVi0NOo13OMYLxr+JZaCdD576EG59XMfEGMHTA+GlltpQDnUNfnBfgDkUKPZLkxbYmJlT",
  "6hdZ5FHMcmZdcd0eQRdEGZJrLNZNFiIHXRbOs9XCwe2WKDl41oL/G2+GgwviP4kE4S9W51vWFaH15BaAGy1otUXftUZeFP5s",
  "Y+RZUfb2bb1qg8GZkb3nQZHIo0ikCzm/7mufEF5HR7/umymKcI3mikBwt7Cn8gC31tLNrFxOFnjGGK8MBWG5sixq40+wH95t",
  "g4MRq8TGWga7haILRNYs5vIKUsiPAq6jWaIgfqIgLuD8B8H670As9FfYcXgOOHgKoiz0I4hhoc8IKcxuRjBUfttn9ZZK3S0V",
  "nmTyY+cvumsldlgnvpZSGmMec06TWT1mFqPEehWyGJl9e0MpWK8VFXmecGN1hx+6iR/4lyIUnYFlneRGn7t3oORzOHS2e5KE",
  "pb3dE9wXzi2EHcaHAcEV4YQwy+lzVgVTKQooGYD6BMiB9SBb0iii6Y+1QvqjdEFDnP+YF0l+xCN3Y2mdkNRoq2dTMiBpKmNh",
  "jYMPMEKmwvlEfrQKY/KE0kMm5ItTGpsLIua0G8EqJDan11F0SqPVFbKnr1HUso3dpW7Rd70rgc1lPexQvcX1ZoeVxUlsV60Y",
  "ErVdxbw3hKRR7fXETKPi6kO55kLIBaPsZE5BpSM2pm0dVzm9I2+oOL1DMzEaKmyaPFpMCjLOz9jovKuVKQmg7a1vW/ZOZJat",
  "ZSbNM9wR+ZWw83sfwp8ym/OYhJ3eb1o7zeY7aoxsvmM231HrACeb75jNd8zmO6o/zeY7aptYpVe+4yvJ5TvmTyLe6YGdZMGb",
  "3YKsW7yYotHsGz10wcO1B736eN+qYPDVx1cWCMNMczwl+CVfWLABdTikqYdlATQooX9WEjjsvHER/rcvXsE0+hlgNmAfA8dQ",
  "fvDnYGO2WG12R+kHLmfZ4hqLhRkJJYwPSrnLyS2W/tR5GEmG94wqrno5zECS/x/SfxQ27npZ+qvPEOSFzn4k/Nt3kcoo/ndj",
  "hauGoEj4SKPF/zelLQi+H+MpAS+3ARFr8vzB9keuBWbcsz87+O7P/h9QSwECFAAKAAAICACOpPlcDMKuYVwAAACEAAAADQAA",
  "AAAAAAAAAAAAAAAAAAAAbWFuaWZlc3QuanNvblBLAQIUAAoAAAgIAI6k+VyVLituTx0AAN5DAQAFAAAAAAAAAAAAAAAAAIcA",
  "AABFTVBUWVBLBQYAAAAAAgACAG4AAAD5HQAAAAA=",
];

/**
 * The blank project as bytes.
 *
 * Decoded here rather than with `atob` or `Buffer`, because `src/` is platform-free — the same
 * bytes have to be available to the CLI and to a browser page with no bundler.
 */
export function blankDn2ProjectFile(): Uint8Array {
  return decodeBase64(CHUNKS.join(""));
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, "");
  const out = new Uint8Array((clean.length * 3) >> 2);
  let bits = 0;
  let held = 0;
  let at = 0;
  for (const ch of clean) {
    const value = ALPHABET.indexOf(ch);
    if (value < 0) throw new Error(`"${ch}" is not base64`);
    held = (held << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (held >> bits) & 0xff;
    }
  }
  return out.subarray(0, at);
}
