const gulp = require('gulp');
const sourcemaps = require('gulp-sourcemaps');
const ts = require('gulp-typescript');

const tsProject = ts.createProject('tsconfig.json');

gulp.task('build', function () {
  return tsProject.src()
    .pipe(sourcemaps.init())
    .pipe(tsProject())
    .js
    .pipe(sourcemaps.write('.', {
      includeContent: false,
      sourceRoot: '../src' // 👈 crucial: path from `dist2` back to `src`
    }))
    .pipe(gulp.dest('dist2'));
});
